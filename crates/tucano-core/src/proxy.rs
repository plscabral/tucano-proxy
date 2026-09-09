use crate::{
    state::AppState,
    storage::{Flow, FlowState},
};
use base64::Engine;
use bytes::Bytes;
use http::{Request, Response};
use http_body_util::BodyExt;
use hudsucker::{Body, HttpContext, HttpHandler, Proxy, RequestOrResponse};
use parking_lot::Mutex;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::SystemTime,
};

pub const MAX_RAW_BODY_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_DECOMPRESSED_BODY_BYTES: usize = 25 * 1024 * 1024;
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
pub(crate) fn is_localhost_alias(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["tucano.local", "tucano.test"]
        .iter()
        .any(|a| host == *a || host.ends_with(&format!(".{a}")))
}
pub(crate) fn headers_to_vec(h: &http::HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}
pub(crate) fn content_type(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}
pub(crate) fn content_encoding(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
}

pub(crate) fn decompress(bytes: &Bytes, encoding: Option<&str>) -> (Bytes, bool) {
    use std::io::Read;
    let Some(enc) = encoding else {
        return (bytes.clone(), false);
    };
    let reader: Box<dyn Read + '_> = match enc {
        "gzip" | "x-gzip" => Box::new(flate2::read::GzDecoder::new(&bytes[..])),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(&bytes[..])),
        "br" => Box::new(brotli::Decompressor::new(&bytes[..], 4096)),
        "zstd" => match zstd::stream::read::Decoder::new(&bytes[..]) {
            Ok(d) => Box::new(d),
            Err(_) => return (bytes.clone(), false),
        },
        _ => return (bytes.clone(), false),
    };
    let mut out = Vec::new();
    let mut result = reader
        .take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64)
        .read_to_end(&mut out);
    if result.is_err() && enc == "deflate" {
        out.clear();
        result = flate2::read::DeflateDecoder::new(&bytes[..])
            .take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64)
            .read_to_end(&mut out);
    }
    if result.is_err() && out.is_empty() {
        return (bytes.clone(), false);
    }
    let truncated = out.len() > MAX_DECOMPRESSED_BODY_BYTES;
    out.truncate(MAX_DECOMPRESSED_BODY_BYTES);
    (Bytes::from(out), truncated)
}
pub(crate) fn encode_body(bytes: &Bytes, ct: Option<&str>) -> (String, &'static str) {
    let text = ct
        .map(|c| {
            ["text", "json", "xml", "javascript", "form-urlencoded"]
                .iter()
                .any(|s| c.contains(s))
        })
        .unwrap_or(false);
    if text {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return (s.into(), "utf8");
        }
    }
    (
        base64::engine::general_purpose::STANDARD.encode(bytes),
        "base64",
    )
}

struct Capture {
    state: Arc<AppState>,
    flow: Flow,
    generation: Option<u64>,
    req_done: bool,
    res_done: bool,
}
impl Capture {
    fn publish(&self) {
        if let Err(error) = self
            .state
            .retain(&self.flow, self.generation, "flow:update")
        {
            tracing::error!("capture persistence: {error}");
        }
    }
    fn finish(
        &mut self,
        response: bool,
        raw: Bytes,
        size: i64,
        truncated: bool,
        error: Option<String>,
    ) {
        let headers = if response {
            &self.flow.res_headers
        } else {
            &self.flow.req_headers
        };
        let encoding = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-encoding"))
            .map(|(_, v)| v.to_ascii_lowercase());
        // Keep request bytes in their original content encoding: replay must not double-encode.
        let (display, expanded) = if response {
            decompress(&raw, encoding.as_deref())
        } else {
            (raw, false)
        };
        let ct = if response {
            self.flow.res_content_type.as_deref()
        } else {
            self.flow.req_content_type.as_deref()
        };
        let (body, enc) = encode_body(
            &display,
            if !response && encoding.is_some() {
                None
            } else {
                ct
            },
        );
        if response {
            self.res_done = true;
            self.flow.res_size = size;
            self.flow.res_body = (!display.is_empty()).then_some(body);
            self.flow.res_body_encoding = enc.into();
            self.flow.res_truncated = truncated || expanded;
        } else {
            self.req_done = true;
            self.flow.req_size = size;
            self.flow.req_body = (!display.is_empty()).then_some(body);
            self.flow.req_body_encoding = enc.into();
            self.flow.req_truncated = truncated;
        }
        if let Some(e) = error {
            self.flow.error = Some(e);
        }
        if self.flow.error.is_some() || (self.req_done && self.res_done) {
            let end = now_ms();
            self.flow.ended_at = Some(end);
            self.flow.duration_ms = Some(end - self.flow.started_at);
            self.flow.state = if self.flow.error.is_some() {
                FlowState::Error
            } else if self.flow.req_truncated || self.flow.res_truncated {
                FlowState::Truncated
            } else {
                FlowState::Complete
            };
        }
        self.publish();
    }
}

/// A transparent body tee: forwards original data AND trailer frames, retaining only a bounded prefix.
struct CaptureBody {
    inner: Body,
    capture: Arc<Mutex<Capture>>,
    response: bool,
    retained: Vec<u8>,
    size: i64,
    done: bool,
}
impl CaptureBody {
    fn wrap(inner: Body, capture: Arc<Mutex<Capture>>, response: bool) -> Body {
        let empty = http_body::Body::is_end_stream(&inner);
        let mut tee = Self {
            inner,
            capture,
            response,
            retained: Vec::new(),
            size: 0,
            done: false,
        };
        if empty {
            tee.finish(None);
        }
        tee.boxed().into()
    }
    fn finish(&mut self, error: Option<String>) {
        if self.done {
            return;
        }
        self.done = true;
        let bytes = Bytes::from(std::mem::take(&mut self.retained));
        let truncated = self.size > bytes.len() as i64;
        self.capture
            .lock()
            .finish(self.response, bytes, self.size, truncated, error);
    }
}
impl http_body::Body for CaptureBody {
    type Data = Bytes;
    type Error = hudsucker::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        let poll = Pin::new(&mut self.inner).poll_frame(cx);
        match &poll {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.size = self.size.saturating_add(data.len() as i64);
                    let remaining = MAX_RAW_BODY_BYTES.saturating_sub(self.retained.len());
                    self.retained
                        .extend_from_slice(&data[..remaining.min(data.len())]);
                }
                if self.inner.is_end_stream() {
                    self.finish(None);
                }
            }
            Poll::Ready(Some(Err(error))) => self.finish(Some(error.to_string())),
            Poll::Ready(None) => self.finish(None),
            Poll::Pending => {}
        }
        poll
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}
impl Drop for CaptureBody {
    fn drop(&mut self) {
        if !self.done {
            self.finish(Some("body stream closed before completion".into()));
        }
    }
}

/// Hudsucker clones a handler for each request/response pair, so pairing is local, not a socket queue.
#[derive(Clone)]
pub struct TucanoHandler {
    pub state: Arc<AppState>,
    capture: Option<Arc<Mutex<Capture>>>,
    lifetime: tokio_util::sync::CancellationToken,
    connect_intercept: Option<bool>,
}
impl HttpHandler for TucanoHandler {
    fn should_intercept(
        &mut self,
        ctx: &HttpContext,
        req: &Request<Body>,
    ) -> impl Future<Output = bool> + Send {
        let state = self.state.clone();
        let port = ctx.client_addr.port();
        let host = req.uri().authority().map(|a| a.host().to_owned());
        let decision = self.connect_intercept;
        async move {
            if let Some(decision) = decision {
                return decision;
            }
            let Some(host) = host else {
                return true;
            };
            let mut should = state.ssl.lock().should_intercept(&host);
            if should {
                let info = tokio::task::spawn_blocking(move || crate::client_proc::resolve(port))
                    .await
                    .unwrap_or_default();
                let ident = format!(
                    "{} {}",
                    info.name.as_deref().unwrap_or(""),
                    info.cmdline.as_deref().unwrap_or("")
                );
                should = !state.ssl.lock().should_skip_app(&ident);
            }
            if !should {
                let mut flow = empty_flow(
                    &state,
                    "CONNECT".into(),
                    "https".into(),
                    host,
                    req.uri().port_u16().unwrap_or(443),
                    "/".into(),
                );
                flow.state = FlowState::Tunnel;
                flow.ended_at = Some(now_ms());
                flow.req_headers = headers_to_vec(req.headers());
                if let Err(error) = state.retain(&flow, state.capture_generation(), "flow:new") {
                    tracing::error!("capture persistence: {error}");
                }
            }
            should
        }
    }
    fn handle_request(
        &mut self,
        ctx: &HttpContext,
        req: Request<Body>,
    ) -> impl Future<Output = RequestOrResponse> + Send {
        let client_port = ctx.client_addr.port();
        let ctx = ctx.clone();
        async move {
            if self.lifetime.is_cancelled() {
                return Response::builder()
                    .status(503)
                    .header("connection", "close")
                    .body(Body::empty())
                    .expect("valid stopped response")
                    .into();
            }
            if req.method() == http::Method::CONNECT {
                self.connect_intercept = None;
                if !self.should_intercept(&ctx, &req).await {
                    return tunnel(req, self.lifetime.clone()).into();
                }
                self.connect_intercept = Some(true);
                return req.into();
            }
            let (mut parts, body) = req.into_parts();
            let authority = parts.uri.authority().cloned().or_else(|| {
                parts
                    .headers
                    .get(http::header::HOST)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<http::uri::Authority>().ok())
            });
            let host = authority
                .as_ref()
                .map(|a| a.host().to_string())
                .unwrap_or_default();
            let scheme = parts.uri.scheme_str().unwrap_or("https").to_owned();
            let port = authority
                .as_ref()
                .and_then(|a| a.port_u16())
                .unwrap_or(if scheme == "https" { 443 } else { 80 });
            let path = parts
                .uri
                .path_and_query()
                .map(|p| p.as_str())
                .unwrap_or("/")
                .to_owned();
            let generation = self.state.capture_generation();
            let mut flow = empty_flow(
                &self.state,
                parts.method.to_string(),
                scheme,
                host.clone(),
                port,
                path,
            );
            flow.req_headers = headers_to_vec(&parts.headers);
            flow.req_content_type = content_type(&parts.headers);
            flow.http_version = format!("{:?}", parts.version);
            flow.client_port = Some(client_port);
            let info =
                tokio::task::spawn_blocking(move || crate::client_proc::resolve(client_port))
                    .await
                    .unwrap_or_default();
            flow.client_app = info.name;
            flow.client_icon = info.icon_data_url;
            if let Err(error) = self.state.retain(&flow, generation, "flow:new") {
                tracing::error!("capture persistence: {error}");
            }
            let capture = Arc::new(Mutex::new(Capture {
                state: self.state.clone(),
                flow,
                generation,
                req_done: false,
                res_done: false,
            }));
            self.capture = Some(capture.clone());
            if is_localhost_alias(&host) {
                let mut uri = parts.uri.clone().into_parts();
                uri.authority = format!("127.0.0.1:{port}").parse().ok();
                if let Ok(uri) = http::Uri::from_parts(uri) {
                    parts.uri = uri;
                }
            }
            Request::from_parts(parts, CaptureBody::wrap(body, capture, false)).into()
        }
    }
    fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> impl Future<Output = Response<Body>> + Send {
        let capture = self.capture.take();
        async move {
            let Some(capture) = capture else {
                return res;
            };
            let (parts, body) = res.into_parts();
            {
                let mut c = capture.lock();
                c.flow.status = Some(parts.status.as_u16() as i64);
                c.flow.status_text = parts.status.canonical_reason().map(str::to_owned);
                c.flow.res_headers = headers_to_vec(&parts.headers);
                c.flow.res_content_type = content_type(&parts.headers);
                c.flow.state = FlowState::Streaming;
                c.publish();
            }
            Response::from_parts(parts, CaptureBody::wrap(body, capture, true))
        }
    }
    fn handle_error(
        &mut self,
        _ctx: &HttpContext,
        error: hyper_util::client::legacy::Error,
    ) -> impl Future<Output = Response<Body>> + Send {
        if let Some(c) = self.capture.take() {
            c.lock()
                .finish(true, Bytes::new(), 0, false, Some(error.to_string()));
        }
        async {
            Response::builder()
                .status(502)
                .body(Body::empty())
                .expect("valid gateway response")
        }
    }
}

/// Own opaque upgrades so stopping capture also stops Hudsucker's otherwise detached tunnels.
fn tunnel(mut req: Request<Body>, lifetime: tokio_util::sync::CancellationToken) -> Response<Body> {
    let Some(authority) = req.uri().authority().cloned() else {
        return Response::builder()
            .status(400)
            .body(Body::empty())
            .expect("valid invalid-authority response");
    };
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = lifetime.cancelled() => {}
            result = async move {
                let upgraded = upgrade.await?;
                let mut client = hyper_util::rt::TokioIo::new(upgraded);
                let mut upstream = tokio::net::TcpStream::connect(authority.as_str()).await?;
                tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
                Ok::<(),Box<dyn std::error::Error + Send + Sync>>(())
            } => {
                if let Err(error) = result { tracing::debug!("opaque tunnel closed: {error}"); }
            }
        }
    });
    Response::builder()
        .status(200)
        .body(Body::empty())
        .expect("valid CONNECT response")
}

#[derive(Clone)]
struct LifecycleWebSockets {
    lifetime: tokio_util::sync::CancellationToken,
}
impl hudsucker::WebSocketHandler for LifecycleWebSockets {
    async fn handle_websocket(
        self,
        _: hudsucker::WebSocketContext,
        mut stream: impl hudsucker::futures::Stream<
                Item = Result<
                    hudsucker::tokio_tungstenite::tungstenite::Message,
                    hudsucker::tokio_tungstenite::tungstenite::Error,
                >,
            > + Unpin
            + Send
            + 'static,
        mut sink: impl hudsucker::futures::Sink<
                hudsucker::tokio_tungstenite::tungstenite::Message,
                Error = hudsucker::tokio_tungstenite::tungstenite::Error,
            > + Unpin
            + Send
            + 'static,
    ) {
        use hudsucker::futures::{SinkExt, StreamExt};
        loop {
            let message = tokio::select! {
                biased;
                _ = self.lifetime.cancelled() => return,
                message = stream.next() => message,
            };
            let Some(Ok(message)) = message else {
                return;
            };
            tokio::select! {
                biased;
                _ = self.lifetime.cancelled() => return,
                result = sink.send(message) => if result.is_err() { return; },
            }
        }
    }
}
pub(crate) fn empty_flow(
    state: &AppState,
    method: String,
    scheme: String,
    host: String,
    port: u16,
    path: String,
) -> Flow {
    Flow {
        id: uuid::Uuid::new_v4().to_string(),
        index: state.allocate_index(),
        started_at: now_ms(),
        ended_at: None,
        method,
        scheme,
        host,
        port,
        path,
        http_version: "HTTP/1.1".into(),
        status: None,
        status_text: None,
        req_headers: vec![],
        req_body: None,
        req_body_encoding: "utf8".into(),
        req_content_type: None,
        req_size: 0,
        res_headers: vec![],
        res_body: None,
        res_body_encoding: "utf8".into(),
        res_content_type: None,
        res_size: 0,
        duration_ms: None,
        error: None,
        client_app: None,
        client_port: None,
        client_icon: None,
        note: None,
        mark: None,
        req_truncated: false,
        res_truncated: false,
        state: FlowState::Pending,
    }
}

pub(crate) fn prepare(
    state: Arc<AppState>,
    listener: tokio::net::TcpListener,
    stop: tokio::sync::oneshot::Receiver<()>,
) -> crate::state::BoxResult<impl Future<Output = crate::state::BoxResult<()>> + Send + 'static> {
    let ca = crate::ca::MitmAuthority::new(&state.ca)?;
    let lifetime = tokio_util::sync::CancellationToken::new();
    *state.proxy_connections.lock() = lifetime.clone();
    let connector = crate::http_client::build_connector_for(Some(state.clone()))?
        .with_lifetime(lifetime.clone());
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .http1_title_case_headers(true)
        .http1_preserve_header_case(true)
        .build(connector);
    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_client(client)
        .with_ca(ca)
        .with_http_handler(TucanoHandler {
            state,
            capture: None,
            lifetime: lifetime.clone(),
            connect_intercept: None,
        })
        .with_websocket_handler(LifecycleWebSockets { lifetime })
        .with_graceful_shutdown(async move {
            let _ = stop.await;
        })
        .build();
    Ok(async move {
        proxy.start().await?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    struct Frames(VecDeque<Result<http_body::Frame<Bytes>, hudsucker::Error>>);
    impl http_body::Body for Frames {
        type Data = Bytes;
        type Error = hudsucker::Error;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
            Poll::Ready(self.0.pop_front())
        }
    }
    fn fixture() -> (tempfile::TempDir, Arc<AppState>, Arc<Mutex<Capture>>) {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(dir.path().into()).unwrap());
        let flow = empty_flow(
            &state,
            "POST".into(),
            "http".into(),
            "example.test".into(),
            80,
            "/".into(),
        );
        let generation = state.capture_generation();
        state.retain(&flow, generation, "flow:new").unwrap();
        let capture = Arc::new(Mutex::new(Capture {
            state: state.clone(),
            flow,
            generation,
            req_done: false,
            res_done: false,
        }));
        (dir, state, capture)
    }
    #[tokio::test]
    async fn inspection_cap_preserves_every_byte_and_trailers() {
        let (_dir, state, capture) = fixture();
        let data = Bytes::from(vec![b'x'; MAX_RAW_BODY_BYTES + 17]);
        let mut trailers = http::HeaderMap::new();
        trailers.insert("x-checksum", http::HeaderValue::from_static("preserved"));
        let body: Body = Frames(VecDeque::from([
            Ok(http_body::Frame::data(data.clone())),
            Ok(http_body::Frame::trailers(trailers.clone())),
        ]))
        .boxed()
        .into();
        let collected = CaptureBody::wrap(body, capture.clone(), false)
            .collect()
            .await
            .unwrap();
        assert_eq!(collected.trailers(), Some(&trailers));
        assert_eq!(collected.to_bytes(), data);
        let flow = state
            .storage
            .lock()
            .get(&capture.lock().flow.id)
            .unwrap()
            .unwrap();
        assert!(flow.req_truncated);
        assert_eq!(flow.req_size, (MAX_RAW_BODY_BYTES + 17) as i64);
    }
    #[tokio::test]
    async fn first_frame_is_forwarded_without_waiting_for_completion() {
        struct FirstThenPending(bool);
        impl http_body::Body for FirstThenPending {
            type Data = Bytes;
            type Error = hudsucker::Error;
            fn poll_frame(
                mut self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
                if self.0 {
                    Poll::Pending
                } else {
                    self.0 = true;
                    Poll::Ready(Some(Ok(http_body::Frame::data(Bytes::from_static(
                        b"data: event\n\n",
                    )))))
                }
            }
        }
        let (_dir, state, capture) = fixture();
        let body: Body = FirstThenPending(false).boxed().into();
        let mut tee = CaptureBody::wrap(body, capture.clone(), true);
        let frame = tokio::time::timeout(std::time::Duration::from_millis(100), tee.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            frame.into_data().unwrap(),
            Bytes::from_static(b"data: event\n\n")
        );
        drop(tee);
        let flow = state
            .storage
            .lock()
            .get(&capture.lock().flow.id)
            .unwrap()
            .unwrap();
        assert_eq!(flow.state, FlowState::Error);
        assert!(flow.ended_at.is_some());
    }
    #[tokio::test]
    async fn upstream_body_error_is_forwarded_and_finalizes_flow() {
        let (_dir, state, capture) = fixture();
        let body: Body = Frames(VecDeque::from([
            Ok(http_body::Frame::data(Bytes::from_static(b"partial"))),
            Err(hudsucker::Error::Io(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "peer reset",
            ))),
        ]))
        .boxed()
        .into();
        assert!(CaptureBody::wrap(body, capture.clone(), true)
            .collect()
            .await
            .is_err());
        let flow = state
            .storage
            .lock()
            .get(&capture.lock().flow.id)
            .unwrap()
            .unwrap();
        assert_eq!(flow.state, FlowState::Error);
        assert!(flow.error.is_some());
        assert_eq!(flow.res_size, 7);
    }

    #[tokio::test]
    async fn stopping_proxy_closes_an_existing_opaque_connect_tunnel() {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (_dir, state, _capture) = fixture();
        let mut settings = crate::ssl_settings::SslSettings::default();
        settings.skip_hosts.push("127.0.0.1".into());
        crate::commands::set_ssl_settings(state.clone(), settings).unwrap();
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.unwrap();
            let (mut read, mut write) = socket.split();
            tokio::io::copy(&mut read, &mut write).await.unwrap();
        });
        crate::commands::start_proxy(state.clone(), 0)
            .await
            .unwrap();
        let mut client =
            tokio::net::TcpStream::connect(("127.0.0.1", state.port.load(Ordering::SeqCst)))
                .await
                .unwrap();
        client.write_all(format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\n\r\n").as_bytes()).await.unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            client.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
        }
        assert!(headers.starts_with(b"HTTP/1.1 200"));
        client.write_all(b"ping").await.unwrap();
        let mut data = [0u8; 4];
        client.read_exact(&mut data).await.unwrap();
        assert_eq!(&data, b"ping");
        crate::commands::stop_proxy(state).await.unwrap();
        let read = tokio::time::timeout(std::time::Duration::from_secs(1), client.read(&mut data))
            .await
            .unwrap();
        match read {
            Ok(length) => assert_eq!(length, 0),
            Err(error) => assert!(matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            )),
        }
        tokio::time::timeout(std::time::Duration::from_secs(1), echo)
            .await
            .unwrap()
            .unwrap();
    }
}
