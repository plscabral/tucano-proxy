use crate::state::AppState;
use crate::storage::Flow;
use base64::Engine;
use http_body_util::{BodyExt, Full};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{Request, Response, body::Bytes},
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use tauri::Emitter;

/// Hard ceilings for buffered capture data. This prevents a malformed or
/// malicious peer from making the desktop process allocate without bound.
pub const MAX_RAW_BODY_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_DECOMPRESSED_BODY_BYTES: usize = 25 * 1024 * 1024;
const BODY_OMITTED: &[u8] = b"[body omitted: capture size limit exceeded]";

#[derive(Clone)]
pub struct TucanoHandler {
    pub state: Arc<AppState>,
    pub pending: Arc<Mutex<HashMap<SocketAddr, VecDeque<Flow>>>>,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Hostname suffix that gets rewritten to 127.0.0.1 when forwarding upstream.
/// Used to bypass the loopback shortcut every browser/HTTP client uses for
/// `localhost`/`127.0.0.1` — the user points their tool at `tucano.local:3000`
/// (or any `*.tucano.local`) and we transparently connect to the local port.
/// `.local` is mDNS-claimed; `.test` is the RFC 6761 reservation we prefer.
const LOCALHOST_ALIAS_SUFFIXES: &[&str] = &["tucano.local", "tucano.test"];

/// Returns true if `host` is one of our localhost aliases (exact or subdomain).
pub(crate) fn is_localhost_alias(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    LOCALHOST_ALIAS_SUFFIXES.iter().any(|a| host == *a || host.ends_with(&format!(".{a}")))
}

pub(crate) fn headers_to_vec(h: &http::HeaderMap) -> Vec<(String, String)> {
    h.iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect()
}

pub(crate) fn content_type(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok().map(|s| s.to_string()))
}

pub(crate) fn content_encoding(h: &http::HeaderMap) -> Option<String> {
    h.get(http::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok().map(|s| s.to_lowercase()))
}

pub(crate) fn decompress(bytes: &Bytes, encoding: Option<&str>) -> Bytes {
    use std::io::Read;
    let enc = match encoding { Some(e) => e, None => return bytes.clone() };
    let mut out = Vec::new();
    let res: std::io::Result<()> = (|| {
        match enc {
            "gzip" | "x-gzip" => {
                let d = flate2::read::GzDecoder::new(&bytes[..]);
                d.take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64).read_to_end(&mut out).map(|_| ())
            }
            "deflate" => {
                let d = flate2::read::ZlibDecoder::new(&bytes[..]);
                if d.take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64).read_to_end(&mut out).is_err() {
                    out.clear();
                    let d = flate2::read::DeflateDecoder::new(&bytes[..]);
                    d.take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64).read_to_end(&mut out).map(|_| ())
                } else { Ok(()) }
            }
            "br" => {
                let d = brotli::Decompressor::new(&bytes[..], 4096);
                d.take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64).read_to_end(&mut out).map(|_| ())
            }
            "zstd" => {
                let d = zstd::stream::read::Decoder::new(&bytes[..])?;
                d.take((MAX_DECOMPRESSED_BODY_BYTES + 1) as u64).read_to_end(&mut out).map(|_| ())
            }
            _ => { out = bytes.to_vec(); Ok(()) }
        }
    })();
    if out.len() > MAX_DECOMPRESSED_BODY_BYTES { return Bytes::from_static(BODY_OMITTED); }
    if res.is_ok() && !out.is_empty() { Bytes::from(out) } else { bytes.clone() }
}

pub(crate) fn encode_body(bytes: &Bytes, ct: Option<&str>) -> (String, &'static str) {
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
        ctx: &HttpContext,
        req: &Request<Body>,
    ) -> impl Future<Output = bool> + Send {
        let should = if req.method() == http::Method::CONNECT {
            // CONNECT URI is `host:port`.
            match req.uri().authority() {
                Some(authority) => {
                    let host = authority.host().to_string();
                    let mut intercept = self.state.ssl.lock().should_intercept(&host);
                    // App-level bypass: some clients (PJe Office and other Java
                    // apps with their own truststore) reject our MITM cert and
                    // break under interception. Resolve the originating process
                    // and tunnel its traffic raw. Only when we'd otherwise
                    // intercept, to avoid the lsof cost on already-bypassed hosts.
                    if intercept {
                        // Match app-bypass rules against BOTH the short name and
                        // the full command line — generic runtimes report as
                        // "java"/"node", so only the cmdline (`… pjeoffice-pro.jar`)
                        // identifies the real app.
                        let info = crate::client_proc::resolve(ctx.client_addr.port());
                        let ident = format!(
                            "{} {}",
                            info.name.as_deref().unwrap_or(""),
                            info.cmdline.as_deref().unwrap_or(""),
                        );
                        if ident.trim() != "" && self.state.ssl.lock().should_skip_app(&ident) {
                            tracing::info!("should_intercept: host={} -> false (app bypass: {})", host, info.name.as_deref().unwrap_or("?"));
                            intercept = false;
                        }
                    }
                    tracing::info!("should_intercept: host={} -> {}", host, intercept);
                    intercept
                }
                None => true,
            }
        } else {
            true
        };

        // When tunneling (not intercepting) a CONNECT, record a minimal flow
        // so the user sees it in the list and can enable SSL per-host.
        if !should && req.method() == http::Method::CONNECT {
            if let Some(authority) = req.uri().authority() {
                let host = authority.host().to_string();
                let port = authority.port_u16().unwrap_or(443);
                let req_headers = headers_to_vec(req.headers());
                let state = self.state.clone();
                let id = uuid::Uuid::new_v4().to_string();
                let idx = state.storage.lock().next_index();
                let flow = Flow {
                    id,
                    index: idx,
                    started_at: now_ms(),
                    ended_at: Some(now_ms()),
                    method: "CONNECT".to_string(),
                    scheme: "https".to_string(),
                    host,
                    port,
                    path: "/".to_string(),
                    http_version: "HTTP/1.1".to_string(),
                    status: None,
                    status_text: None,
                    req_headers,
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
                };
                if !state.private_mode.load(Ordering::SeqCst) {
                    let _ = state.app.emit("flow:new", &flow);
                    let _ = state.storage.lock().upsert(&flow);
                    let limit = state.keep_limit.load(Ordering::Relaxed);
                    if limit > 0 {
                        let trimmed = state.storage.lock().trim_to_limit(limit);
                        if !trimmed.is_empty() {
                            let _ = state.app.emit("flows:trimmed", &trimmed);
                        }
                    }
                }
            }
        }

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

            let bytes = match http_body_util::Limited::new(body, MAX_RAW_BODY_BYTES).collect().await {
                Ok(body) => body.to_bytes(),
                Err(_) => {
                    return RequestOrResponse::Response(Response::builder()
                        .status(http::StatusCode::PAYLOAD_TOO_LARGE)
                        .body(body_from_bytes(Bytes::from_static(BODY_OMITTED)))
                        .expect("valid payload-limit response"));
                }
            };
            let req_enc = content_encoding(&parts.headers);
            let display_bytes = decompress(&bytes, req_enc.as_deref());

            // For MITM'd HTTPS, hudsucker delivers the inner requests with a
            // relative URI (no scheme/host) — the host lives in the Host header.
            let host_header = parts.headers.get(http::header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let host_from_hdr = host_header.split(':').next().unwrap_or("").to_string();
            let port_from_hdr = host_header.split(':').nth(1)
                .and_then(|p| p.parse::<u16>().ok());

            let uri_has_authority = parts.uri.scheme_str().is_some() && parts.uri.host().is_some();
            let (scheme, host, port) = if uri_has_authority {
                let s = parts.uri.scheme_str().unwrap_or("http").to_string();
                let h = parts.uri.host().unwrap_or("").to_string();
                let p = parts.uri.port_u16().unwrap_or(if s == "https" { 443 } else { 80 });
                (s, h, p)
            } else {
                // Relative URI → MITM'd HTTPS request. Infer from Host header.
                let p = port_from_hdr.unwrap_or(443);
                let s = if p == 443 { "https" } else { "http" }.to_string();
                (s, host_from_hdr, p)
            };

            let path = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
            let ct = content_type(&parts.headers);
            tracing::debug!("handle_request: {} {} scheme={} host={}", parts.method, path, scheme, host);
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

            let mut flow = Flow {
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

            crate::storage::redact_flow(&mut flow);

            if !self.state.private_mode.load(Ordering::SeqCst) {
                let _ = self.state.app.emit("flow:new", &flow);
                let _ = self.state.storage.lock().upsert(&flow);

                // Trim oldest flows if a keep-limit is set.
                let limit = self.state.keep_limit.load(Ordering::Relaxed);
                if limit > 0 {
                    let trimmed = self.state.storage.lock().trim_to_limit(limit);
                    if !trimmed.is_empty() {
                        let _ = self.state.app.emit("flows:trimmed", &trimmed);
                    }
                }
                self.pending.lock().entry(client).or_default().push_back(flow);
            }

            // Localhost alias: rewrite the upstream authority from
            // `tucano.local[:port]` to `127.0.0.1[:port]` so hudsucker's
            // hyper client connects to the local dev server. The Host
            // header is preserved (parts.headers unchanged) so vhost-based
            // dev setups still route correctly. The Flow stored above keeps
            // the alias hostname for display.
            let mut parts = parts;
            let original_host_for_rewrite = parts.uri.host().map(|s| s.to_string());
            if let Some(orig_host) = original_host_for_rewrite {
                if is_localhost_alias(&orig_host) {
                    let mut up = parts.uri.clone().into_parts();
                    let port = parts.uri.port_u16();
                    let auth_str = match port {
                        Some(p) => format!("127.0.0.1:{p}"),
                        None => "127.0.0.1".to_string(),
                    };
                    if let Ok(a) = auth_str.parse::<http::uri::Authority>() {
                        up.authority = Some(a);
                        if let Ok(new_uri) = http::Uri::from_parts(up) {
                            parts.uri = new_uri;
                        }
                    }
                }
            }

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
            let bytes = match http_body_util::Limited::new(body, MAX_RAW_BODY_BYTES).collect().await {
                Ok(body) => body.to_bytes(),
                Err(_) => {
                    return Response::builder()
                        .status(http::StatusCode::BAD_GATEWAY)
                        .body(body_from_bytes(Bytes::from_static(BODY_OMITTED)))
                        .expect("valid payload-limit response");
                }
            };
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
            // Do not fall back to another client's queue: concurrent responses
            // could otherwise be persisted against the wrong request.
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
                crate::storage::redact_flow(f);
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
    let connector = crate::http_client::build_connector()?;
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .http1_title_case_headers(true)
        .http1_preserve_header_case(true)
        .build(connector);

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
