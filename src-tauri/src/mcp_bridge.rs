use crate::ssl_settings::SslSettings;
use crate::state::AppState;
use axum::{
    extract::{Path as AxPath, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::{sleep, Duration};

/// Start the MCP bridge in a background task. Stores the stop sender on
/// `AppState.mcp_stop_tx` so subsequent settings changes can tear it down.
pub fn spawn(state: Arc<AppState>, port: u16, token: String) {
    let (tx, rx) = oneshot::channel();
    *state.mcp_stop_tx.lock() = Some(tx);
    let st = state.clone();
    // Use Tauri's async runtime handle — `tokio::spawn` panics when called
    // from sync contexts that don't have a runtime entered (e.g. plain
    // tauri::command fns invoked from the JS side).
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(st, port, token, rx).await {
            tracing::error!("[mcp-bridge] {e}");
        }
    });
}

async fn run(
    state: Arc<AppState>,
    port: u16,
    token: String,
    stop_rx: oneshot::Receiver<()>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let auth_token = token.clone();
    let app = Router::new()
        .route("/status", get(status))
        .route("/stats", get(stats_handler))
        .route("/search", get(search_handler))
        .route("/wait", get(wait_handler))
        .route("/diff", get(diff_handler))
        .route("/ssl", get(get_ssl_handler).post(set_ssl_handler))
        .route("/flows", get(list_flows).delete(delete_flows_handler))
        .route("/flows/:id", get(get_flow_handler))
        .route("/flows/:id/req_body", get(req_body_handler))
        .route("/flows/:id/res_body", get(res_body_handler))
        .route("/flows/:id/replay", post(replay_handler))
        .route("/compose", post(compose_handler))
        .route("/clear", post(clear_handler))
        .route("/capture/start", post(start_capture_handler))
        .route("/capture/stop", post(stop_capture_handler))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let token = auth_token.clone();
            async move { check_auth(req, next, token).await }
        }))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("[mcp-bridge] listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = stop_rx.await;
            tracing::info!("[mcp-bridge] shutting down");
        })
        .await?;
    Ok(())
}

async fn check_auth(req: Request, next: Next, token: String) -> Result<Response, StatusCode> {
    let expected = format!("Bearer {token}");
    let got = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());
    if got != Some(expected.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn flow_url(f: &crate::storage::Flow) -> String {
    let default_port =
        (f.scheme == "https" && f.port == 443) || (f.scheme == "http" && f.port == 80);
    if default_port {
        format!("{}://{}{}", f.scheme, f.host, f.path)
    } else {
        format!("{}://{}:{}{}", f.scheme, f.host, f.port, f.path)
    }
}

fn status_class(status: Option<i64>) -> &'static str {
    match status {
        Some(s) if (100..200).contains(&s) => "1xx",
        Some(s) if (200..300).contains(&s) => "2xx",
        Some(s) if (300..400).contains(&s) => "3xx",
        Some(s) if (400..500).contains(&s) => "4xx",
        Some(s) if s >= 500 => "5xx",
        _ => "none",
    }
}

/// Body-less summary used by list/search — keeps list responses tiny so the
/// LLM can scan many flows before drilling into a single one.
fn summary(f: &crate::storage::Flow) -> Value {
    json!({
        "id": f.id,
        "index": f.index,
        "startedAt": f.started_at,
        "endedAt": f.ended_at,
        "method": f.method,
        "scheme": f.scheme,
        "host": f.host,
        "port": f.port,
        "path": f.path,
        "status": f.status,
        "statusText": f.status_text,
        "durationMs": f.duration_ms,
        "reqSize": f.req_size,
        "resSize": f.res_size,
        "reqContentType": f.req_content_type,
        "resContentType": f.res_content_type,
        "clientApp": f.client_app,
        "note": f.note,
        "error": f.error,
    })
}

/// Slice a string on UTF-8 char boundaries so we never panic mid-codepoint.
fn safe_slice(s: &str, start: usize, end: usize) -> &str {
    let len = s.len();
    let mut a = start.min(len);
    let mut b = end.min(len);
    while a < len && !s.is_char_boundary(a) {
        a += 1;
    }
    while b < len && !s.is_char_boundary(b) {
        b += 1;
    }
    if a > b {
        a = b;
    }
    &s[a..b]
}

fn slice_text(s: &str, offset: usize, max: usize) -> (String, usize, usize, bool) {
    let total = s.len();
    if offset >= total {
        return (String::new(), total, 0, false);
    }
    let slice = safe_slice(s, offset, offset.saturating_add(max));
    let returned = slice.len();
    let truncated = offset + returned < total;
    (slice.to_string(), total, returned, truncated)
}

fn slice_b64(b64: &str, offset: usize, max: usize) -> (String, usize, usize, bool) {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .unwrap_or_default();
    let total = bytes.len();
    if offset >= total {
        return (String::new(), total, 0, false);
    }
    let end = offset.saturating_add(max).min(total);
    let slice = base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]);
    (slice, total, end - offset, end < total)
}

// ─── status / stats ──────────────────────────────────────────────────────────

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let count = state.storage.lock().list().map(|v| v.len()).unwrap_or(0);
    Json(json!({
        "running": state.running.load(Ordering::SeqCst),
        "port": state.port.load(Ordering::SeqCst),
        "systemProxyOn": state.system_proxy_on.load(Ordering::SeqCst),
        "flowsCount": count,
    }))
}

async fn stats_handler(State(state): State<Arc<AppState>>) -> Response {
    let flows = match state.storage.lock().list() {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let mut by_status: HashMap<&str, i64> = HashMap::new();
    let mut by_method: HashMap<String, i64> = HashMap::new();
    let mut by_host: HashMap<String, (i64, i64)> = HashMap::new(); // count, resBytes
    let mut by_ct: HashMap<String, i64> = HashMap::new();
    let mut total_req: i64 = 0;
    let mut total_res: i64 = 0;
    let mut errors: i64 = 0;
    let mut first = i64::MAX;
    let mut last = i64::MIN;

    for f in &flows {
        *by_status.entry(status_class(f.status)).or_insert(0) += 1;
        *by_method.entry(f.method.clone()).or_insert(0) += 1;
        let e = by_host.entry(f.host.clone()).or_insert((0, 0));
        e.0 += 1;
        e.1 += f.res_size;
        let ct = f
            .res_content_type
            .as_deref()
            .map(|c| c.split(';').next().unwrap_or(c).trim().to_string())
            .unwrap_or_else(|| "—".to_string());
        *by_ct.entry(ct).or_insert(0) += 1;
        total_req += f.req_size;
        total_res += f.res_size;
        if f.error.is_some() || f.status.map(|s| s >= 500).unwrap_or(false) {
            errors += 1;
        }
        first = first.min(f.started_at);
        if let Some(end) = f.ended_at {
            last = last.max(end);
        }
        last = last.max(f.started_at);
    }

    let mut hosts: Vec<Value> = by_host
        .into_iter()
        .map(|(host, (count, res))| json!({ "host": host, "count": count, "resBytes": res }))
        .collect();
    hosts.sort_by(|a, b| b["count"].as_i64().cmp(&a["count"].as_i64()));
    hosts.truncate(20);

    let mut cts: Vec<Value> = by_ct
        .into_iter()
        .map(|(ct, n)| json!({ "contentType": ct, "count": n }))
        .collect();
    cts.sort_by(|a, b| b["count"].as_i64().cmp(&a["count"].as_i64()));
    cts.truncate(15);

    let mut slowest: Vec<&crate::storage::Flow> = flows.iter().filter(|f| f.duration_ms.is_some()).collect();
    slowest.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
    let slowest: Vec<Value> = slowest
        .into_iter()
        .take(10)
        .map(|f| json!({ "id": f.id, "url": flow_url(f), "durationMs": f.duration_ms, "status": f.status }))
        .collect();

    let mut largest: Vec<&crate::storage::Flow> = flows.iter().collect();
    largest.sort_by(|a, b| b.res_size.cmp(&a.res_size));
    let largest: Vec<Value> = largest
        .into_iter()
        .take(10)
        .map(|f| json!({ "id": f.id, "url": flow_url(f), "resSize": f.res_size }))
        .collect();

    let by_status_v = serde_json::to_value(&by_status).unwrap_or(Value::Null);
    let by_method_v = serde_json::to_value(&by_method).unwrap_or(Value::Null);

    Json(json!({
        "total": flows.len(),
        "totalReqBytes": total_req,
        "totalResBytes": total_res,
        "errors": errors,
        "byStatusClass": by_status_v,
        "byMethod": by_method_v,
        "byHost": hosts,
        "byContentType": cts,
        "slowest": slowest,
        "largest": largest,
        "timeRange": {
            "firstStartedAt": if first == i64::MAX { Value::Null } else { json!(first) },
            "lastSeenAt": if last == i64::MIN { Value::Null } else { json!(last) },
        },
    }))
    .into_response()
}

// ─── list (rich filters + pagination) ────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    host: Option<String>,
    method: Option<String>,
    status: Option<i64>,
    status_min: Option<i64>,
    status_max: Option<i64>,
    status_class: Option<String>,
    content_type: Option<String>,
    path: Option<String>,
    client_app: Option<String>,
    min_duration_ms: Option<i64>,
    min_size: Option<i64>,
    q: Option<String>,
    since: Option<i64>,
}

fn flow_matches(f: &crate::storage::Flow, q: &ListQuery, needle: &Option<String>) -> bool {
    if let Some(h) = &q.host {
        if !f.host.to_lowercase().contains(&h.to_lowercase()) {
            return false;
        }
    }
    if let Some(m) = &q.method {
        if !f.method.eq_ignore_ascii_case(m) {
            return false;
        }
    }
    if let Some(s) = q.status {
        if f.status != Some(s) {
            return false;
        }
    }
    if let Some(lo) = q.status_min {
        if f.status.map(|s| s < lo).unwrap_or(true) {
            return false;
        }
    }
    if let Some(hi) = q.status_max {
        if f.status.map(|s| s > hi).unwrap_or(true) {
            return false;
        }
    }
    if let Some(cls) = &q.status_class {
        if !status_class(f.status).eq_ignore_ascii_case(cls) {
            return false;
        }
    }
    if let Some(ct) = &q.content_type {
        let ctl = ct.to_lowercase();
        let hay = format!(
            "{} {}",
            f.res_content_type.as_deref().unwrap_or(""),
            f.req_content_type.as_deref().unwrap_or("")
        )
        .to_lowercase();
        if !hay.contains(&ctl) {
            return false;
        }
    }
    if let Some(p) = &q.path {
        if !f.path.to_lowercase().contains(&p.to_lowercase()) {
            return false;
        }
    }
    if let Some(app) = &q.client_app {
        let a = f.client_app.as_deref().unwrap_or("").to_lowercase();
        if !a.contains(&app.to_lowercase()) {
            return false;
        }
    }
    if let Some(d) = q.min_duration_ms {
        if f.duration_ms.map(|x| x < d).unwrap_or(true) {
            return false;
        }
    }
    if let Some(sz) = q.min_size {
        if f.res_size.max(f.req_size) < sz {
            return false;
        }
    }
    if let Some(ts) = q.since {
        if f.started_at < ts {
            return false;
        }
    }
    if let Some(n) = needle {
        let hay = format!("{} {} {}", f.host, f.path, f.method).to_lowercase();
        if !hay.contains(n) {
            return false;
        }
    }
    true
}

async fn list_flows(State(state): State<Arc<AppState>>, Query(q): Query<ListQuery>) -> Response {
    let flows = match state.storage.lock().list() {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let needle = q.q.as_ref().map(|s| s.to_lowercase());
    let filtered: Vec<_> = flows
        .into_iter()
        .filter(|f| flow_matches(f, &q, &needle))
        .collect();

    // Paginate from the newest end: offset skips the newest N, limit takes the
    // next page. Output stays oldest→newest (newest last) for stable reading.
    let total = filtered.len();
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(total);
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(limit);
    let page: Vec<Value> = filtered[start..end].iter().map(summary).collect();
    Json(page).into_response()
}

// ─── search (server-side grep over bodies + headers) ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: String,
    /// "all" (default) | "body" | "headers"
    scope: Option<String>,
    limit: Option<usize>,
    ignore_case: Option<bool>,
}

fn make_snippet(hay: &str, needle: &str, ignore_case: bool) -> Option<String> {
    let (h, n) = if ignore_case {
        (hay.to_lowercase(), needle.to_lowercase())
    } else {
        (hay.to_string(), needle.to_string())
    };
    let pos = h.find(&n)?;
    // Slice the (possibly lowercased) haystack we matched against, so byte
    // positions are guaranteed valid. Snippet is a preview, exact casing is not
    // important here.
    let start = pos.saturating_sub(60);
    let end = (pos + n.len() + 60).min(h.len());
    let body = safe_slice(&h, start, end);
    Some(format!("…{}…", body))
}

async fn search_handler(State(state): State<Arc<AppState>>, Query(q): Query<SearchQuery>) -> Response {
    if q.q.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "q is required").into_response();
    }
    let flows = match state.storage.lock().list() {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let scope = q.scope.as_deref().unwrap_or("all");
    let want_body = scope == "all" || scope == "body";
    let want_headers = scope == "all" || scope == "headers";
    let ignore_case = q.ignore_case.unwrap_or(true);
    let limit = q.limit.unwrap_or(50).min(500);
    let needle = q.q.clone();
    let contains = |hay: &str| -> bool {
        if ignore_case {
            hay.to_lowercase().contains(&needle.to_lowercase())
        } else {
            hay.contains(&needle)
        }
    };

    let mut results: Vec<Value> = Vec::new();
    // Newest first — most relevant for "what just happened" queries.
    for f in flows.iter().rev() {
        if results.len() >= limit {
            break;
        }
        let mut matches: Vec<Value> = Vec::new();
        if want_headers {
            for (k, v) in &f.req_headers {
                let line = format!("{k}: {v}");
                if contains(&line) {
                    matches.push(json!({ "where": "reqHeader", "snippet": make_snippet(&line, &needle, ignore_case) }));
                    break;
                }
            }
            for (k, v) in &f.res_headers {
                let line = format!("{k}: {v}");
                if contains(&line) {
                    matches.push(json!({ "where": "resHeader", "snippet": make_snippet(&line, &needle, ignore_case) }));
                    break;
                }
            }
        }
        if want_body {
            if f.req_body_encoding == "utf8" {
                if let Some(b) = &f.req_body {
                    if contains(b) {
                        matches.push(json!({ "where": "reqBody", "snippet": make_snippet(b, &needle, ignore_case) }));
                    }
                }
            }
            if f.res_body_encoding == "utf8" {
                if let Some(b) = &f.res_body {
                    if contains(b) {
                        matches.push(json!({ "where": "resBody", "snippet": make_snippet(b, &needle, ignore_case) }));
                    }
                }
            }
        }
        if !matches.is_empty() {
            results.push(json!({
                "id": f.id,
                "index": f.index,
                "method": f.method,
                "url": flow_url(f),
                "status": f.status,
                "matches": matches,
            }));
        }
    }

    Json(json!({ "query": q.q, "scope": scope, "count": results.len(), "results": results }))
        .into_response()
}

// ─── wait (long-poll for a matching flow) ────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitQuery {
    host: Option<String>,
    path: Option<String>,
    method: Option<String>,
    status: Option<i64>,
    /// Only consider flows at/after this epoch-ms. Defaults to "now" so only
    /// traffic that arrives after the call is matched.
    since: Option<i64>,
    timeout_ms: Option<u64>,
}

async fn wait_handler(State(state): State<Arc<AppState>>, Query(q): Query<WaitQuery>) -> Response {
    let since = q.since.unwrap_or_else(now_ms);
    let timeout = q.timeout_ms.unwrap_or(15_000).min(60_000);
    let deadline = Instant::now() + Duration::from_millis(timeout);

    loop {
        let found = {
            let flows = match state.storage.lock().list() {
                Ok(v) => v,
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            };
            flows.into_iter().rev().find(|f| {
                if f.started_at < since {
                    return false;
                }
                if let Some(h) = &q.host {
                    if !f.host.to_lowercase().contains(&h.to_lowercase()) {
                        return false;
                    }
                }
                if let Some(p) = &q.path {
                    if !f.path.to_lowercase().contains(&p.to_lowercase()) {
                        return false;
                    }
                }
                if let Some(m) = &q.method {
                    if !f.method.eq_ignore_ascii_case(m) {
                        return false;
                    }
                }
                if let Some(s) = q.status {
                    if f.status != Some(s) {
                        return false;
                    }
                }
                // Only match completed flows (have a response) to avoid racing.
                f.ended_at.is_some() || f.status.is_some() || f.error.is_some()
            })
        };
        if let Some(f) = found {
            return Json(json!({ "matched": true, "flow": summary(&f) })).into_response();
        }
        if Instant::now() >= deadline {
            return Json(json!({ "matched": false, "timedOut": true, "since": since })).into_response();
        }
        sleep(Duration::from_millis(250)).await;
    }
}

// ─── diff (compare two flows) ────────────────────────────────────────────────

#[derive(Deserialize)]
struct DiffQuery {
    a: String,
    b: String,
}

fn header_map(hs: &[(String, String)]) -> HashMap<String, String> {
    hs.iter()
        .map(|(k, v)| (k.to_lowercase(), v.clone()))
        .collect()
}

fn diff_headers(a: &[(String, String)], b: &[(String, String)]) -> Value {
    let ma = header_map(a);
    let mb = header_map(b);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (k, vb) in &mb {
        match ma.get(k) {
            None => added.push(json!([k, vb])),
            Some(va) if va != vb => changed.push(json!([k, va, vb])),
            _ => {}
        }
    }
    for (k, va) in &ma {
        if !mb.contains_key(k) {
            removed.push(json!([k, va]));
        }
    }
    json!({ "added": added, "removed": removed, "changed": changed })
}

async fn diff_handler(State(state): State<Arc<AppState>>, Query(q): Query<DiffQuery>) -> Response {
    let (fa, fb) = {
        let s = state.storage.lock();
        let fa = match s.get(&q.a) {
            Ok(Some(f)) => f,
            Ok(None) => return (StatusCode::NOT_FOUND, "flow a not found").into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        };
        let fb = match s.get(&q.b) {
            Ok(Some(f)) => f,
            Ok(None) => return (StatusCode::NOT_FOUND, "flow b not found").into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        };
        (fa, fb)
    };

    let mut meta = serde_json::Map::new();
    if fa.method != fb.method {
        meta.insert("method".into(), json!([fa.method, fb.method]));
    }
    if flow_url(&fa) != flow_url(&fb) {
        meta.insert("url".into(), json!([flow_url(&fa), flow_url(&fb)]));
    }
    if fa.status != fb.status {
        meta.insert("status".into(), json!([fa.status, fb.status]));
    }
    if fa.duration_ms != fb.duration_ms {
        meta.insert("durationMs".into(), json!([fa.duration_ms, fb.duration_ms]));
    }

    Json(json!({
        "a": { "id": fa.id, "url": flow_url(&fa), "status": fa.status },
        "b": { "id": fb.id, "url": flow_url(&fb), "status": fb.status },
        "meta": Value::Object(meta),
        "reqHeaders": diff_headers(&fa.req_headers, &fb.req_headers),
        "resHeaders": diff_headers(&fa.res_headers, &fb.res_headers),
        "reqBody": { "equal": fa.req_body == fb.req_body, "aBytes": fa.req_size, "bBytes": fb.req_size },
        "resBody": { "equal": fa.res_body == fb.res_body, "aBytes": fa.res_size, "bBytes": fb.res_size },
    }))
    .into_response()
}

// ─── single flow + bodies ────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowQuery {
    include_bodies: Option<bool>,
}

async fn get_flow_handler(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<FlowQuery>,
) -> Response {
    match state.storage.lock().get(&id) {
        Ok(Some(mut f)) => {
            if q.include_bodies == Some(false) {
                f.req_body = None;
                f.res_body = None;
            }
            Json(f).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "flow not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BodyQuery {
    max_bytes: Option<usize>,
    offset: Option<usize>,
}

fn body_response(body: Option<String>, enc: String, q: &BodyQuery) -> Response {
    let max = q.max_bytes.unwrap_or(65_536);
    let offset = q.offset.unwrap_or(0);
    match body {
        None => Json(json!({ "encoding": enc, "empty": true })).into_response(),
        Some(b) if enc == "base64" => {
            let (slice, total, ret, trunc) = slice_b64(&b, offset, max);
            Json(json!({
                "encoding": "base64",
                "base64": slice,
                "offset": offset,
                "returnedBytes": ret,
                "totalBytes": total,
                "truncated": trunc,
                "note": "binary payload, base64-encoded",
            }))
            .into_response()
        }
        Some(b) => {
            let (slice, total, ret, trunc) = slice_text(&b, offset, max);
            Json(json!({
                "encoding": "utf8",
                "text": slice,
                "offset": offset,
                "returnedBytes": ret,
                "totalBytes": total,
                "truncated": trunc,
            }))
            .into_response()
        }
    }
}

async fn req_body_handler(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<BodyQuery>,
) -> Response {
    match state.storage.lock().get(&id) {
        Ok(Some(f)) => body_response(f.req_body, f.req_body_encoding, &q),
        Ok(None) => (StatusCode::NOT_FOUND, "flow not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn res_body_handler(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<BodyQuery>,
) -> Response {
    match state.storage.lock().get(&id) {
        Ok(Some(f)) => body_response(f.res_body, f.res_body_encoding, &q),
        Ok(None) => (StatusCode::NOT_FOUND, "flow not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ─── mutations ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DeleteBody {
    ids: Vec<String>,
}

async fn delete_flows_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DeleteBody>,
) -> Response {
    match state.storage.lock().delete_many(&body.ids) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayBody {
    /// Full header replacement (legacy). When provided, used as the base set.
    #[serde(default)]
    headers: Option<Vec<(String, String)>>,
    /// Granular: override/add specific headers (case-insensitive by name).
    #[serde(default)]
    set_headers: Option<Vec<(String, String)>>,
    /// Granular: remove specific headers by name (case-insensitive).
    #[serde(default)]
    remove_headers: Option<Vec<String>>,
    body: Option<String>,
}

async fn replay_handler(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<ReplayBody>,
) -> Response {
    let flow = match state.storage.lock().get(&id) {
        Ok(Some(f)) => f,
        Ok(None) => return (StatusCode::NOT_FOUND, "flow not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    // Start from the full-replace set if given, else the original headers.
    let mut headers: Vec<(String, String)> =
        body.headers.unwrap_or_else(|| flow.req_headers.clone());
    if let Some(remove) = &body.remove_headers {
        let drop: Vec<String> = remove.iter().map(|s| s.to_lowercase()).collect();
        headers.retain(|(k, _)| !drop.contains(&k.to_lowercase()));
    }
    if let Some(set) = body.set_headers {
        for (k, v) in set {
            let kl = k.to_lowercase();
            if let Some(existing) = headers.iter_mut().find(|(ek, _)| ek.to_lowercase() == kl) {
                existing.1 = v;
            } else {
                headers.push((k, v));
            }
        }
    }

    match crate::commands::send_request(state, flow, headers, body.body, "MCP Replay").await {
        Ok(new_id) => Json(json!({ "id": new_id })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct ComposeBody {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<String>,
    #[serde(default = "default_true")]
    log: bool,
}

fn default_true() -> bool {
    true
}

async fn compose_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ComposeBody>,
) -> Response {
    match crate::commands::compose_internal(state, body.method, body.url, body.headers, body.body, body.log).await {
        Ok(flow) => Json(flow).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn clear_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.storage.lock().clear() {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize, Default)]
struct StartCaptureBody {
    port: Option<u16>,
}

async fn start_capture_handler(
    State(state): State<Arc<AppState>>,
    body: Option<Json<StartCaptureBody>>,
) -> Response {
    let port = body
        .and_then(|Json(b)| b.port)
        .unwrap_or_else(|| state.port.load(Ordering::SeqCst));
    match crate::commands::start_capture_internal(state, port).await {
        Ok(()) => Json(json!({ "running": true, "port": port })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn stop_capture_handler(State(state): State<Arc<AppState>>) -> Response {
    match crate::commands::stop_capture_internal(state).await {
        Ok(()) => Json(json!({ "running": false })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ─── SSL settings (so the LLM can make HTTPS bodies actually decryptable) ─────

async fn get_ssl_handler(State(state): State<Arc<AppState>>) -> Response {
    Json(state.ssl.lock().clone()).into_response()
}

async fn set_ssl_handler(
    State(state): State<Arc<AppState>>,
    Json(settings): Json<SslSettings>,
) -> Response {
    if let Err(e) = settings.save(&state.data_dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    *state.ssl.lock() = settings.clone();
    Json(settings).into_response()
}
