use hudsucker::rustls;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::connect::{Connected, Connection};
use std::sync::Arc;
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};
use tower_service::Service;

struct HostVerifier {
    secure: Arc<rustls::client::WebPkiServerVerifier>,
    state: Option<Arc<crate::state::AppState>>,
}
impl std::fmt::Debug for HostVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostVerifier").finish_non_exhaustive()
    }
}
impl rustls::client::danger::ServerCertVerifier for HostVerifier {
    fn verify_server_cert(
        &self,
        end: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let host = name.to_str();
        let insecure = self.state.as_ref().is_some_and(|s| {
            s.ssl
                .lock()
                .insecure_hosts
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(host.as_ref()))
        });
        if insecure {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        self.secure
            .verify_server_cert(end, intermediates, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.secure.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.secure.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.secure.supported_verify_schemes()
    }
}
pub fn build_connector() -> crate::state::BoxResult<HttpsConnector<HttpConnector>> {
    build_tls_connector(None)
}
pub fn build_connector_for(
    state: Option<Arc<crate::state::AppState>>,
) -> crate::state::BoxResult<PolicyConnector> {
    let policy = state
        .as_ref()
        .map(|state| state.tls_policy.lock().clone())
        .unwrap_or_default();
    let inner = build_tls_connector(state.clone())?;
    Ok(PolicyConnector {
        inner: Arc::new(parking_lot::Mutex::new(CachedConnector { inner, policy })),
        state,
        lifetime: None,
    })
}

fn build_tls_connector(
    state: Option<Arc<crate::state::AppState>>,
) -> crate::state::BoxResult<HttpsConnector<HttpConnector>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let secure = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build()?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(HostVerifier { secure, state }))
        .with_no_client_auth();
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    Ok(hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .wrap_connector(http))
}

/// Keeps HTTP connection pooling while making TLS trust revocation immediate.
#[derive(Clone)]
pub struct PolicyConnector {
    inner: Arc<parking_lot::Mutex<CachedConnector>>,
    state: Option<Arc<crate::state::AppState>>,
    lifetime: Option<CancellationToken>,
}
struct CachedConnector {
    inner: HttpsConnector<HttpConnector>,
    policy: CancellationToken,
}
impl PolicyConnector {
    pub(crate) fn with_lifetime(mut self, token: CancellationToken) -> Self {
        self.lifetime = Some(token);
        self
    }
}

impl Service<http::Uri> for PolicyConnector {
    type Response = PolicyStream<<HttpsConnector<HttpConnector> as Service<http::Uri>>::Response>;
    type Error = <HttpsConnector<HttpConnector> as Service<http::Uri>>::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.lock().inner.poll_ready(cx)
    }
    fn call(&mut self, uri: http::Uri) -> Self::Future {
        let guard = self.state.as_ref().map(|state| state.tls_policy.lock());
        let current = guard.as_deref().cloned().unwrap_or_default();
        let token = if uri.scheme_str() == Some("https") {
            current.clone()
        } else {
            CancellationToken::new()
        };
        let mut cached = self.inner.lock();
        if cached.policy.is_cancelled() {
            // A fresh rustls config also discards tickets/session IDs issued under the old policy.
            match build_tls_connector(self.state.clone()) {
                Ok(inner) => {
                    cached.inner = inner;
                    cached.policy = current;
                }
                Err(error) => return Box::pin(async move { Err(error) }),
            }
        }
        let connecting = cached.inner.call(uri);
        drop(cached);
        drop(guard);
        let lifetime = self.lifetime.clone();
        Box::pin(async move {
            let inner = tokio::select! {
                biased;
                _=token.cancelled()=>Err::<_,Self::Error>(revoked().into()),
                _=async {
                    if let Some(token)=&lifetime { token.cancelled().await; }
                    else { std::future::pending::<()>().await; }
                }=>Err::<_,Self::Error>(revoked().into()),
                result=connecting=>result,
            }?;
            Ok(PolicyStream {
                inner,
                cancelled: Box::pin(token.cancelled_owned()),
                stopped: lifetime.map(|token| Box::pin(token.cancelled_owned())),
            })
        })
    }
}

pub struct PolicyStream<T> {
    inner: T,
    // Boxed waiters keep the IO stream Unpin, as required by hyper's connector contract.
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    stopped: Option<Pin<Box<WaitForCancellationFutureOwned>>>,
}
impl<T> PolicyStream<T> {
    fn is_revoked(&mut self, cx: &mut Context<'_>) -> bool {
        self.cancelled.as_mut().poll(cx).is_ready()
            || self
                .stopped
                .as_mut()
                .is_some_and(|waiter| waiter.as_mut().poll(cx).is_ready())
    }
}

fn revoked() -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "upstream connection revoked by policy change or proxy shutdown",
    )
}

impl<T: Connection> Connection for PolicyStream<T> {
    fn connected(&self) -> Connected {
        self.inner.connected()
    }
}
impl<T: hyper::rt::Read + Unpin> hyper::rt::Read for PolicyStream<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.is_revoked(cx) {
            return Poll::Ready(Err(revoked()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}
impl<T: hyper::rt::Write + Unpin> hyper::rt::Write for PolicyStream<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.is_revoked(cx) {
            return Poll::Ready(Err(revoked()));
        }
        Pin::new(&mut this.inner).poll_write(cx, buf)
    }
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.is_revoked(cx) {
            return Poll::Ready(Err(revoked()));
        }
        Pin::new(&mut this.inner).poll_write_vectored(cx, bufs)
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.is_revoked(cx) {
            return Poll::Ready(Err(revoked()));
        }
        Pin::new(&mut this.inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.is_revoked(cx) {
            return Poll::Ready(Err(revoked()));
        }
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper_util::rt::TokioIo;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn removing_exception_aborts_pending_io_on_existing_connection() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(crate::state::AppState::new(dir.path().into()).unwrap());
        let mut settings = crate::ssl_settings::SslSettings::default();
        settings.insecure_hosts.push("127.0.0.1".into());
        crate::commands::set_ssl_settings(state.clone(), settings.clone()).unwrap();
        let token = state.tls_policy.lock().clone();
        let (socket, _peer) = tokio::io::duplex(64);
        let mut stream = TokioIo::new(PolicyStream {
            inner: TokioIo::new(socket),
            cancelled: Box::pin(token.cancelled_owned()),
            stopped: None,
        });
        let mut byte = [0u8; 1];
        let pending = stream.read_exact(&mut byte);
        tokio::pin!(pending);
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx).is_pending())).await
        );
        settings.insecure_hosts.clear();
        crate::commands::set_ssl_settings(state, settings).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_millis(100), pending)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
    }

    #[tokio::test]
    async fn proxy_stop_revokes_proxy_socket_but_not_composer_socket() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(crate::state::AppState::new(dir.path().into()).unwrap());
        let policy = state.tls_policy.lock().clone();
        let lifetime = state.proxy_connections.lock().clone();
        let (proxy_socket, _proxy_peer) = tokio::io::duplex(64);
        let (compose_socket, mut compose_peer) = tokio::io::duplex(64);
        let mut proxy = TokioIo::new(PolicyStream {
            inner: TokioIo::new(proxy_socket),
            cancelled: Box::pin(policy.clone().cancelled_owned()),
            stopped: Some(Box::pin(lifetime.cancelled_owned())),
        });
        let mut compose = TokioIo::new(PolicyStream {
            inner: TokioIo::new(compose_socket),
            cancelled: Box::pin(policy.cancelled_owned()),
            stopped: None,
        });
        crate::commands::stop_proxy(state).await.unwrap();
        let mut byte = [0u8; 1];
        assert_eq!(
            proxy.read_exact(&mut byte).await.unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        compose_peer.write_all(b"x").await.unwrap();
        compose.read_exact(&mut byte).await.unwrap();
        assert_eq!(&byte, b"x");
    }
}
