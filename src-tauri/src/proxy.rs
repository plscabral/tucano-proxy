use crate::state::AppState;
use crate::storage::Flow;
use base64::Engine;
use http_body_util::{BodyExt, Full};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{Request, Response, body::Bytes},
    rustls,
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::SystemTime;
use tauri::Emitter;

/// rustls verifier that accepts every upstream certificate. Required so
/// Tucano can MITM dev servers / localhost / internal hosts presenting
/// self-signed or untrusted certs (PJe Office's local server, etc.) —
/// the same default Proxyman/Charles use ("Disable SSL verification").
#[derive(Debug)]
struct AcceptAllVerifier;

impl rustls::client::danger::ServerCertVerifier for AcceptAllVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        use rustls::SignatureScheme::*;
        vec![
            RSA_PKCS1_SHA256, RSA_PKCS1_SHA384, RSA_PKCS1_SHA512,
            RSA_PSS_SHA256, RSA_PSS_SHA384, RSA_PSS_SHA512,
            ECDSA_NISTP256_SHA256, ECDSA_NISTP384_SHA384, ECDSA_NISTP521_SHA512,
            ED25519, ED448,
        ]
    }
}

#[derive(Clone)]
pub struct TucanoHandler {
    pub state: Arc<AppState>,
    pub pending: Arc<Mutex<HashMap<SocketAddr, VecDeque<Flow>>>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn headers_to_vec(h: &http::HeaderMap) -> Vec<(String, String)> {
    h.iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect()
}

fn content_type(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok().map(|s| s.to_string()))
}

fn content_encoding(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok().map(|s| s.to_lowercase()))
}

fn decompress(bytes: &Bytes, encoding: Option<&str>) -> Bytes {
    use std::io::Read;
    let enc = match encoding { Some(e) => e, None => return bytes.clone() };
    let mut out = Vec::new();
    let res: std::io::Result<()> = (|| {
        match enc {
            "gzip" | "x-gzip" => {
                let mut d = flate2::read::GzDecoder::new(&bytes[..]);
                d.read_to_end(&mut out).map(|_| ())
            }
            "deflate" => {
                let mut d = flate2::read::ZlibDecoder::new(&bytes[..]);
                if d.read_to_end(&mut out).is_err() {
                    out.clear();
                    let mut d = flate2::read::DeflateDecoder::new(&bytes[..]);
                    d.read_to_end(&mut out).map(|_| ())
                } else { Ok(()) }
            }
            "br" => {
                let mut d = brotli::Decompressor::new(&bytes[..], 4096);
                d.read_to_end(&mut out).map(|_| ())
            }
            "zstd" => {
                let mut d = zstd::stream::read::Decoder::new(&bytes[..])?;
                d.read_to_end(&mut out).map(|_| ())
            }
            _ => { out = bytes.to_vec(); Ok(()) }
        }
    })();
    if res.is_ok() && !out.is_empty() { Bytes::from(out) } else { bytes.clone() }
}

fn encode_body(bytes: &Bytes, ct: Option<&str>) -> (String, &'static str) {
    let is_text = ct.map(|c| c.contains("text") || c.contains("json") || c.contains("xml") || c.contains("javascript") || c.contains("html") || c.contains("form-urlencoded")).unwrap_or(false);
    if is_text {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_string(), "utf8"),
            Err(_) => {
                // Many legacy / government / Java backends still serve text
                // as ISO-8859-1 (Latin-1). Decode each byte to its Unicode
                // code point — this always succeeds and produces a readable
                // string. Charles/Proxyman do the same.
                let decoded: String = bytes.iter().map(|&b| b as char).collect();
                (decoded, "utf8")
            }
        }
    } else {
        (base64::engine::general_purpose::STANDARD.encode(bytes), "base64")
    }
}

fn body_from_bytes(b: Bytes) -> Body {
    Full::new(b).map_err(|e: std::convert::Infallible| match e {}).boxed().into()
}

impl HttpHandler for TucanoHandler {
    /// Decide per-CONNECT whether to MITM-intercept. For hosts in the SSL
    /// blocklist (or outside an allowlist) we tunnel raw bytes — so client
    /// certificate handshakes (PJe Office, banks, jus.br) survive intact.
    fn should_intercept(
        &mut self,
        _ctx: &HttpContext,
        req: &Request<Body>,
    ) -> impl Future<Output = bool> + Send {
        let should = if req.method() == http::Method::CONNECT {
            // CONNECT URI is `host:port`.
            let authority = req.uri().authority().map(|a| a.host().to_string());
            match authority {
                Some(host) => self.state.ssl.lock().should_intercept(&host),
                None => true,
            }
        } else {
            true
        };
        async move { should }
    }

    fn handle_request(
        &mut self,
        ctx: &HttpContext,
        req: Request<Body>,
    ) -> impl Future<Output = RequestOrResponse> + Send {
        let client = ctx.client_addr;
        async move {
            let (parts, body) = req.into_parts();

            // Skip CONNECT — these are HTTPS tunnel-setup requests handled
            // internally by hudsucker. Recording them throws off our
            // request/response pairing because hudsucker doesn't deliver
            // the matching response to handle_response.
            if parts.method == http::Method::CONNECT {
                let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                return RequestOrResponse::Request(Request::from_parts(parts, body_from_bytes(bytes)));
            }

            let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            let req_enc = content_encoding(&parts.headers);
            let display_bytes = decompress(&bytes, req_enc.as_deref());

            let scheme = parts.uri.scheme_str().unwrap_or("http").to_string();
            let host = parts.uri.host().unwrap_or("").to_string();
            let port = parts.uri.port_u16().unwrap_or(if scheme == "https" { 443 } else { 80 });
            let path = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
            let ct = content_type(&parts.headers);
            let ssl_capture = scheme != "https" || self.state.ssl.lock().should_capture(&host);
            let (body_str, enc) = if !ssl_capture {
                (Some("(SSL not decrypted — host excluded)".to_string()), "utf8".to_string())
            } else if display_bytes.is_empty() {
                (None, "utf8".to_string())
            } else {
                let (s, e) = encode_body(&display_bytes, ct.as_deref());
                (Some(s), e.to_string())
            };

            let id = uuid::Uuid::new_v4().to_string();
            let idx = self.state.storage.lock().next_index();

            // Resolve client app SYNCHRONOUSLY before emitting the flow.
            // The PORT_CACHE in client_proc makes this near-instant after
            // the first hit per source port — and resolving while the TCP
            // connection is still ESTABLISHED is the only way to be sure
            // lsof/netstat can find it (otherwise short-lived connections
            // close before async resolution runs, especially when Tucano
            // is in the background and macOS App Nap throttles spawns).
            let client_port = client.port();
            let client_info = tokio::task::spawn_blocking(move || {
                crate::client_proc::resolve(client_port)
            }).await.unwrap_or_default();

            let flow = Flow {
                id: id.clone(),
                index: idx,
                started_at: now_ms(),
                ended_at: None,
                method: parts.method.as_str().to_string(),
                scheme,
                host,
                port,
                path,
                http_version: format!("{:?}", parts.version),
                status: None,
                status_text: None,
                req_headers: headers_to_vec(&parts.headers),
                req_body: body_str,
                req_body_encoding: enc,
                req_content_type: ct,
                req_size: bytes.len() as i64,
                res_headers: vec![],
                res_body: None,
                res_body_encoding: "utf8".into(),
                res_content_type: None,
                res_size: 0,
                duration_ms: None,
                error: None,
                client_app: client_info.name,
                client_port: Some(client_port),
                client_icon: client_info.icon_data_url,
                note: None,
            };

            let _ = self.state.app.emit("flow:new", &flow);
            let _ = self.state.storage.lock().upsert(&flow);

            self.pending.lock().entry(client).or_default().push_back(flow);

            RequestOrResponse::Request(Request::from_parts(parts, body_from_bytes(bytes)))
        }
    }

    fn handle_response(
        &mut self,
        ctx: &HttpContext,
        res: Response<Body>,
    ) -> impl Future<Output = Response<Body>> + Send {
        let client = ctx.client_addr;
        async move {
            let (parts, body) = res.into_parts();
            let bytes = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            let res_enc = content_encoding(&parts.headers);
            let display_bytes = decompress(&bytes, res_enc.as_deref());

            let ct = content_type(&parts.headers);
            let (body_str, enc) = if display_bytes.is_empty() {
                (None, "utf8".to_string())
            } else {
                let (s, e) = encode_body(&display_bytes, ct.as_deref());
                (Some(s), e.to_string())
            };

            let mut pending = self.pending.lock();
            let mut flow = pending.get_mut(&client).and_then(|q| q.pop_front());
            let host_for_check = flow.as_ref().map(|f| (f.scheme.clone(), f.host.clone()));
            if flow.is_none() {
                // fallback: any oldest pending across clients (shouldn't normally happen)
                if let Some((_, q)) = pending.iter_mut().find(|(_, q)| !q.is_empty()) {
                    flow = q.pop_front();
                }
            }
            let ssl_capture = match host_for_check {
                Some((s, h)) if s == "https" => self.state.ssl.lock().should_capture(&h),
                _ => true,
            };
            let body_str = if ssl_capture { body_str } else { Some("(SSL not decrypted — host excluded)".into()) };
            let enc = if ssl_capture { enc } else { "utf8".into() };
            if let Some(ref mut f) = flow {
                f.status = Some(parts.status.as_u16() as i64);
                f.status_text = parts.status.canonical_reason().map(|s| s.to_string());
                f.res_headers = headers_to_vec(&parts.headers);
                f.res_body = body_str;
                f.res_body_encoding = enc;
                f.res_content_type = ct;
                f.res_size = display_bytes.len() as i64;
                f.ended_at = Some(now_ms());
                f.duration_ms = Some(f.ended_at.unwrap() - f.started_at);
                let _ = self.state.app.emit("flow:update", &*f);
                let _ = self.state.storage.lock().upsert(f);
            }
            drop(pending);

            Response::from_parts(parts, body_from_bytes(bytes))
        }
    }
}

pub async fn run(state: Arc<AppState>, port: u16, stop_rx: tokio::sync::oneshot::Receiver<()>)
    -> Result<(), Box<dyn std::error::Error + Send + Sync>>
{
    let key = rcgen::KeyPair::from_pem(&state.ca.key_pem)?;
    let ca_cert = rcgen::CertificateParams::from_ca_cert_pem(&state.ca.cert_pem)?
        .self_signed(&key)?;

    let ca = RcgenAuthority::new(key, ca_cert, 1_000);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let handler = TucanoHandler { state: state.clone(), pending: Arc::new(Mutex::new(HashMap::new())) };

    // Build a hyper client that accepts every upstream cert. This lets us
    // MITM hosts with self-signed / untrusted certs (PJe Office on
    // localhost, internal staging servers, dev environments) — without it,
    // those connections fail before we ever see a request.
    let tls_config = rustls::ClientConfig::builder_with_provider(
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAllVerifier))
        .with_no_client_auth();

    let mut http_connector = hyper_util::client::legacy::connect::HttpConnector::new();
    http_connector.enforce_http(false);

    let https_connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls_config)
        .https_or_http()
        .enable_http1()
        .wrap_connector(http_connector);

    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .http1_title_case_headers(true)
        .http1_preserve_header_case(true)
        .build(https_connector);

    let proxy = Proxy::builder()
        .with_addr(addr)
        .with_client(client)
        .with_ca(ca)
        .with_http_handler(handler)
        .with_graceful_shutdown(async move { let _ = stop_rx.await; })
        .build();

    proxy.start().await?;
    Ok(())
}
