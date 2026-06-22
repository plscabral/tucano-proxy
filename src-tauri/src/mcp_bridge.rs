use crate::ssl_settings::SslSettings;
use crate::state::AppState;
use axum::{
    extract::Request,
    extract::State,
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::post,
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

/// MCP protocol version we advertise when a client doesn't pin one.
const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

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
    // Single MCP Streamable-HTTP endpoint. POST carries JSON-RPC; GET would be a
    // server→client SSE stream (we don't push, so it 405s); DELETE ends a
    // session (stateless here, so it's a no-op 200).
    let app = Router::new()
        .route("/mcp", post(mcp_post).get(mcp_get).delete(mcp_delete))
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let token = auth_token.clone();
            async move { check_auth(req, next, token).await }
        }))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("[mcp-bridge] MCP HTTP endpoint on http://{addr}/mcp");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = stop_rx.await;
            tracing::info!("[mcp-bridge] shutting down");
        })
        .await?;
    Ok(())
}

async fn check_auth(req: Request, next: Next, token: String) -> Result<Response, StatusCode> {
    // Accept the token via the `Authorization: Bearer` header (preferred) OR a
    // `?token=`/`?key=` query param. The query form exists for clients that
    // can't attach custom headers from their config (e.g. Claude Desktop, which
    // only takes a bare `url`). It's loopback-only, so it's no weaker than the
    // header — the URL never leaves the machine.
    let expected = format!("Bearer {token}");
    let header_ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some(expected.as_str());
    let query_ok = req
        .uri()
        .query()
        .map(|q| query_token_matches(q, &token))
        .unwrap_or(false);
    if !header_ok && !query_ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

/// True if the query string carries `token=<token>` or `key=<token>`.
fn query_token_matches(query: &str, token: &str) -> bool {
    query.split('&').any(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == "token" || k == "key") && v == token
    })
}

// ─── JSON-RPC / Streamable-HTTP transport ─────────────────────────────────────

/// GET /mcp — we don't offer a server-initiated SSE stream, so per the spec the
/// server returns 405 Method Not Allowed.
async fn mcp_get() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

/// DELETE /mcp — session teardown. We're stateless, so just acknowledge.
async fn mcp_delete() -> Response {
    StatusCode::OK.into_response()
}

async fn mcp_post(State(state): State<Arc<AppState>>, body: Json<Value>) -> Response {
    let Json(payload) = body;
    // A batch is an array of messages; a single call is one object.
    let messages: Vec<Value> = match payload {
        Value::Array(a) => a,
        other => vec![other],
    };

    let mut responses: Vec<Value> = Vec::new();
    for msg in messages {
        if let Some(resp) = handle_rpc(&state, msg).await {
            responses.push(resp);
        }
    }

    // Notifications/responses only → 202 Accepted with no body (per spec).
    if responses.is_empty() {
        return StatusCode::ACCEPTED.into_response();
    }
    if responses.len() == 1 {
        return Json(responses.into_iter().next().unwrap()).into_response();
    }
    Json(Value::Array(responses)).into_response()
}

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Handle one JSON-RPC message. Returns `None` for notifications (no `id`),
/// which must not produce a response body.
async fn handle_rpc(state: &Arc<AppState>, msg: Value) -> Option<Value> {
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    // No id → notification. We don't act on any of them but must stay silent.
    let Some(id) = id else { return None };

    match method {
        "initialize" => {
            // Echo the client's requested protocol version when it pins one.
            let proto = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION)
                .to_string();
            Some(rpc_ok(
                id,
                json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "tucano", "version": SERVER_VERSION },
                    "instructions": "Tucano Proxy — inspect, search, replay and compose captured HTTP/HTTPS traffic.",
                }),
            ))
        }
        "ping" => Some(rpc_ok(id, json!({}))),
        "tools/list" => Some(rpc_ok(id, json!({ "tools": tools_list() }))),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(state, name, args).await {
                Ok(result) => {
                    let text = match &result {
                        Value::String(s) => s.clone(),
                        other => serde_json::to_string_pretty(other).unwrap_or_default(),
                    };
                    Some(rpc_ok(
                        id,
                        json!({ "content": [{ "type": "text", "text": text }] }),
                    ))
                }
                Err(e) => Some(rpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": format!("tucano error: {e}") }],
                        "isError": true,
                    }),
                )),
            }
        }
        other => Some(rpc_err(id, -32601, &format!("method not found: {other}"))),
    }
}

/// Dispatch a tool call to its implementation.
async fn call_tool(state: &Arc<AppState>, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "tucano_status" => tool_status(state),
        "tucano_list_flows" => tool_list_flows(state, args),
        "tucano_get_flow" => tool_get_flow(state, args),
        "tucano_get_request_body" => tool_get_body(state, args, BodyWhich::Req).await,
        "tucano_get_response_body" => tool_get_body(state, args, BodyWhich::Res).await,
        "tucano_replay_flow" => tool_replay(state, args).await,
        "tucano_compose_request" => tool_compose(state, args).await,
        "tucano_delete_flows" => tool_delete(state, args),
        "tucano_clear_flows" => tool_clear(state),
        "tucano_start_capture" => tool_start_capture(state, args).await,
        "tucano_stop_capture" => tool_stop_capture(state).await,
        "tucano_export_as_curl" => tool_export_curl(state, args),
        "tucano_export_as_code" => tool_export_code(state, args),
        "tucano_export_as_har" => tool_export_har(state, args),
        "tucano_search" => tool_search(state, args),
        "tucano_stats" => tool_stats(state),
        "tucano_wait_for" => tool_wait(state, args).await,
        "tucano_diff" => tool_diff(state, args),
        "tucano_get_ssl_settings" => tool_get_ssl(state),
        "tucano_set_ssl_settings" => tool_set_ssl(state, args),
        other => Err(format!("unknown tool: {other}")),
    }
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

/// Parse a list of `[name, value]` pairs from a JSON array argument.
fn header_pairs(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let pa = p.as_array()?;
                    Some((
                        pa.first()?.as_str()?.to_string(),
                        pa.get(1)?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ─── status / stats ──────────────────────────────────────────────────────────

fn tool_status(state: &Arc<AppState>) -> Result<Value, String> {
    let count = state.storage.lock().list().map(|v| v.len()).unwrap_or(0);
    Ok(json!({
        "running": state.running.load(Ordering::SeqCst),
        "port": state.port.load(Ordering::SeqCst),
        "systemProxyOn": state.system_proxy_on.load(Ordering::SeqCst),
        "flowsCount": count,
    }))
}

fn tool_stats(state: &Arc<AppState>) -> Result<Value, String> {
    let flows = state.storage.lock().list().map_err(|e| e.to_string())?;
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

    let mut slowest: Vec<&crate::storage::Flow> =
        flows.iter().filter(|f| f.duration_ms.is_some()).collect();
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

    Ok(json!({
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
}

// ─── list (rich filters + pagination) ────────────────────────────────────────

#[derive(Deserialize, Default)]
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

fn tool_list_flows(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let q: ListQuery = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let flows = state.storage.lock().list().map_err(|e| e.to_string())?;
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
    Ok(Value::Array(page))
}

// ─── search (server-side grep over bodies + headers) ─────────────────────────

#[derive(Deserialize, Default)]
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
    let start = pos.saturating_sub(60);
    let end = (pos + n.len() + 60).min(h.len());
    let body = safe_slice(&h, start, end);
    Some(format!("…{}…", body))
}

fn tool_search(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let q: SearchQuery = serde_json::from_value(args).map_err(|e| e.to_string())?;
    if q.q.trim().is_empty() {
        return Err("q is required".to_string());
    }
    let flows = state.storage.lock().list().map_err(|e| e.to_string())?;
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

    Ok(json!({ "query": q.q, "scope": scope, "count": results.len(), "results": results }))
}

// ─── wait (long-poll for a matching flow) ────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WaitQuery {
    host: Option<String>,
    path: Option<String>,
    method: Option<String>,
    status: Option<i64>,
    since: Option<i64>,
    timeout_ms: Option<u64>,
}

async fn tool_wait(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let q: WaitQuery = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let since = q.since.unwrap_or_else(now_ms);
    let timeout = q.timeout_ms.unwrap_or(15_000).min(60_000);
    let deadline = Instant::now() + Duration::from_millis(timeout);

    loop {
        let found = {
            let flows = state.storage.lock().list().map_err(|e| e.to_string())?;
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
                f.ended_at.is_some() || f.status.is_some() || f.error.is_some()
            })
        };
        if let Some(f) = found {
            return Ok(json!({ "matched": true, "flow": summary(&f) }));
        }
        if Instant::now() >= deadline {
            return Ok(json!({ "matched": false, "timedOut": true, "since": since }));
        }
        sleep(Duration::from_millis(250)).await;
    }
}

// ─── diff (compare two flows) ────────────────────────────────────────────────

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

fn tool_diff(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let a = args.get("a").and_then(|v| v.as_str()).ok_or("a is required")?;
    let b = args.get("b").and_then(|v| v.as_str()).ok_or("b is required")?;
    let (fa, fb) = {
        let s = state.storage.lock();
        let fa = s.get(a).map_err(|e| e.to_string())?.ok_or("flow a not found")?;
        let fb = s.get(b).map_err(|e| e.to_string())?.ok_or("flow b not found")?;
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

    Ok(json!({
        "a": { "id": fa.id, "url": flow_url(&fa), "status": fa.status },
        "b": { "id": fb.id, "url": flow_url(&fb), "status": fb.status },
        "meta": Value::Object(meta),
        "reqHeaders": diff_headers(&fa.req_headers, &fb.req_headers),
        "resHeaders": diff_headers(&fa.res_headers, &fb.res_headers),
        "reqBody": { "equal": fa.req_body == fb.req_body, "aBytes": fa.req_size, "bBytes": fb.req_size },
        "resBody": { "equal": fa.res_body == fb.res_body, "aBytes": fa.res_size, "bBytes": fb.res_size },
    }))
}

// ─── single flow + bodies ────────────────────────────────────────────────────

fn tool_get_flow(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
    let include_bodies = args
        .get("includeBodies")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    match state.storage.lock().get(id).map_err(|e| e.to_string())? {
        Some(mut f) => {
            if !include_bodies {
                f.req_body = None;
                f.res_body = None;
            }
            serde_json::to_value(&f).map_err(|e| e.to_string())
        }
        None => Err("flow not found".to_string()),
    }
}

enum BodyWhich {
    Req,
    Res,
}

fn body_payload(body: Option<String>, enc: String, max: usize, offset: usize) -> Value {
    match body {
        None => json!({ "encoding": enc, "empty": true }),
        Some(b) if enc == "base64" => {
            let (slice, total, ret, trunc) = slice_b64(&b, offset, max);
            json!({
                "encoding": "base64",
                "base64": slice,
                "offset": offset,
                "returnedBytes": ret,
                "totalBytes": total,
                "truncated": trunc,
                "note": "binary payload, base64-encoded",
            })
        }
        Some(b) => {
            let (slice, total, ret, trunc) = slice_text(&b, offset, max);
            json!({
                "encoding": "utf8",
                "text": slice,
                "offset": offset,
                "returnedBytes": ret,
                "totalBytes": total,
                "truncated": trunc,
            })
        }
    }
}

async fn tool_get_body(state: &Arc<AppState>, args: Value, which: BodyWhich) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
    let select = args.get("select").and_then(|v| v.as_str()).map(|s| s.to_string());
    let max = args.get("maxBytes").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(65_536);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(0);

    let flow = state.storage.lock().get(id).map_err(|e| e.to_string())?.ok_or("flow not found")?;
    let (body, enc) = match which {
        BodyWhich::Req => (flow.req_body, flow.req_body_encoding),
        BodyWhich::Res => (flow.res_body, flow.res_body_encoding),
    };

    // `select` extracts a JSON sub-value from the (full) body — a huge token
    // saver vs. pulling the whole payload and slicing client-side.
    if let Some(sel) = select {
        return Ok(json_select(&body, &enc, &sel));
    }
    Ok(body_payload(body, enc, max, offset))
}

// ─── JSON select (dot/bracket path extraction over a body) ────────────────────

enum Token {
    Key(String),
    Index(usize),
    Star,
}

fn tokenize_path(path: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut buf = String::new();
    let mut chars = path.chars().peekable();
    let flush = |buf: &mut String, tokens: &mut Vec<Token>| {
        if !buf.is_empty() {
            tokens.push(Token::Key(std::mem::take(buf)));
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '.' => flush(&mut buf, &mut tokens),
            '[' => {
                flush(&mut buf, &mut tokens);
                let mut inner = String::new();
                for ic in chars.by_ref() {
                    if ic == ']' {
                        break;
                    }
                    inner.push(ic);
                }
                if inner == "*" {
                    tokens.push(Token::Star);
                } else if let Ok(idx) = inner.trim().parse::<usize>() {
                    tokens.push(Token::Index(idx));
                }
            }
            _ => buf.push(c),
        }
    }
    flush(&mut buf, &mut tokens);
    tokens
}

fn eval_path(value: &Value, tokens: &[Token]) -> Vec<Value> {
    let mut cur = vec![value.clone()];
    for tk in tokens {
        let mut next = Vec::new();
        for v in &cur {
            match tk {
                Token::Star => {
                    if let Some(arr) = v.as_array() {
                        next.extend(arr.iter().cloned());
                    }
                }
                Token::Index(i) => {
                    if let Some(arr) = v.as_array() {
                        if let Some(x) = arr.get(*i) {
                            next.push(x.clone());
                        }
                    }
                }
                Token::Key(k) => {
                    if let Some(x) = v.get(k) {
                        next.push(x.clone());
                    }
                }
            }
        }
        cur = next;
    }
    cur
}

fn json_select(body: &Option<String>, enc: &str, select: &str) -> Value {
    let Some(text) = body else {
        return json!({ "select": select, "value": null, "note": "empty body" });
    };
    if enc != "utf8" {
        return json!({ "select": select, "error": "body is binary — cannot JSON-select" });
    }
    let parsed: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return json!({ "select": select, "error": "body is not valid JSON" }),
    };
    let tokens = tokenize_path(select);
    let has_star = tokens.iter().any(|t| matches!(t, Token::Star));
    let res = eval_path(&parsed, &tokens);
    let value = if has_star {
        Value::Array(res)
    } else {
        res.into_iter().next().unwrap_or(Value::Null)
    };
    json!({ "select": select, "totalBytes": text.len(), "value": value })
}

// ─── mutations ───────────────────────────────────────────────────────────────

fn tool_delete(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let ids: Vec<String> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    state.storage.lock().delete_many(&ids).map_err(|e| e.to_string())?;
    Ok(json!({ "deleted": ids.len() }))
}

fn tool_clear(state: &Arc<AppState>) -> Result<Value, String> {
    state.storage.lock().clear().map_err(|e| e.to_string())?;
    Ok(json!({ "cleared": true }))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReplayBody {
    #[serde(default)]
    headers: Option<Vec<(String, String)>>,
    #[serde(default)]
    set_headers: Option<Vec<(String, String)>>,
    #[serde(default)]
    remove_headers: Option<Vec<String>>,
    body: Option<String>,
}

async fn tool_replay(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?.to_string();
    let body: ReplayBody = serde_json::from_value(args).map_err(|e| e.to_string())?;

    let flow = state.storage.lock().get(&id).map_err(|e| e.to_string())?.ok_or("flow not found")?;

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

    let new_id = crate::commands::send_request(state.clone(), flow, headers, body.body, "MCP Replay").await?;
    Ok(json!({ "id": new_id }))
}

async fn tool_compose(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let method = args.get("method").and_then(|v| v.as_str()).ok_or("method is required")?.to_string();
    let url = args.get("url").and_then(|v| v.as_str()).ok_or("url is required")?.to_string();
    let headers = header_pairs(args.get("headers"));
    let body = args.get("body").and_then(|v| v.as_str()).map(|s| s.to_string());
    let log = args.get("log").and_then(|v| v.as_bool()).unwrap_or(true);

    let flow = crate::commands::compose_internal(state.clone(), method, url, headers, body, log).await?;
    serde_json::to_value(&flow).map_err(|e| e.to_string())
}

async fn tool_start_capture(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let port = args
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|p| p as u16)
        .unwrap_or_else(|| state.port.load(Ordering::SeqCst));
    crate::commands::start_capture_internal(state.clone(), port).await?;
    Ok(json!({ "running": true, "port": port }))
}

async fn tool_stop_capture(state: &Arc<AppState>) -> Result<Value, String> {
    crate::commands::stop_capture_internal(state.clone()).await?;
    Ok(json!({ "running": false }))
}

// ─── SSL settings ─────────────────────────────────────────────────────────────

fn tool_get_ssl(state: &Arc<AppState>) -> Result<Value, String> {
    serde_json::to_value(state.ssl.lock().clone()).map_err(|e| e.to_string())
}

fn tool_set_ssl(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let settings: SslSettings = serde_json::from_value(args).map_err(|e| e.to_string())?;
    settings.save(&state.data_dir).map_err(|e| e.to_string())?;
    *state.ssl.lock() = settings.clone();
    serde_json::to_value(&settings).map_err(|e| e.to_string())
}

// ─── exporters (curl / code / HAR) ────────────────────────────────────────────

fn flow_ids(args: &Value) -> Vec<String> {
    args.get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

fn fetch_flows(state: &Arc<AppState>, ids: &[String]) -> Vec<crate::storage::Flow> {
    let s = state.storage.lock();
    ids.iter().filter_map(|id| s.get(id).ok().flatten()).collect()
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Header names stripped from generated requests — they're recomputed by the
/// client and copying them verbatim only causes mismatches.
fn skip_header(k: &str) -> bool {
    let k = k.to_lowercase();
    k == "content-length" || k == "host"
}

fn body_as_text(f: &crate::storage::Flow) -> Option<&str> {
    if f.req_body_encoding == "base64" {
        return None; // skip binary
    }
    f.req_body.as_deref()
}

fn flow_to_curl(f: &crate::storage::Flow, include_headers: bool) -> String {
    let mut lines = vec![format!("curl -X {} {}", f.method, shell_quote(&flow_url(f)))];
    if include_headers {
        for (k, v) in &f.req_headers {
            if skip_header(k) {
                continue;
            }
            lines.push(format!("  -H {}", shell_quote(&format!("{k}: {v}"))));
        }
    }
    if let Some(body) = body_as_text(f) {
        lines.push(format!("  --data-raw {}", shell_quote(body)));
    }
    lines.join(" \\\n")
}

fn header_object(f: &crate::storage::Flow) -> Value {
    let mut map = serde_json::Map::new();
    for (k, v) in &f.req_headers {
        if skip_header(k) {
            continue;
        }
        map.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(map)
}

fn js_str(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string())
}

fn flow_to_code(f: &crate::storage::Flow, lang: &str) -> String {
    let url = flow_url(f);
    let headers = serde_json::to_string_pretty(&header_object(f)).unwrap_or_else(|_| "{}".to_string());
    let body = body_as_text(f);
    match lang {
        "axios" => {
            let mut l = vec![
                "import axios from \"axios\";".to_string(),
                String::new(),
                "const res = await axios.request({".to_string(),
                format!("  method: {},", js_str(&f.method)),
                format!("  url: {},", js_str(&url)),
                format!("  headers: {},", headers),
            ];
            if let Some(b) = body {
                l.push(format!("  data: {},", js_str(b)));
            }
            l.push("});".to_string());
            l.join("\n")
        }
        "python" => {
            let mut l = vec![
                "import requests".to_string(),
                String::new(),
                "res = requests.request(".to_string(),
                format!("    method={},", js_str(&f.method)),
                format!("    url={},", js_str(&url)),
                format!("    headers={},", headers),
            ];
            if let Some(b) = body {
                l.push(format!("    data={},", js_str(b)));
            }
            l.push(")".to_string());
            l.join("\n")
        }
        _ => {
            // default: fetch
            let mut l = vec![
                format!("const res = await fetch({}, {{", js_str(&url)),
                format!("  method: {},", js_str(&f.method)),
                format!("  headers: {},", headers),
            ];
            if let Some(b) = body {
                l.push(format!("  body: {},", js_str(b)));
            }
            l.push("});".to_string());
            l.join("\n")
        }
    }
}

/// Convert epoch-millis to an ISO-8601 UTC timestamp (HAR's startedDateTime).
fn epoch_ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // days since 1970-01-01 → civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, m, d, hh, mm, ss, millis
    )
}

fn har_headers(hs: &[(String, String)]) -> Value {
    Value::Array(hs.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
}

fn flow_to_har(flows: &[crate::storage::Flow]) -> Value {
    let entries: Vec<Value> = flows
        .iter()
        .map(|f| {
            let post_data = f.req_body.as_ref().map(|text| {
                let mut o = json!({
                    "mimeType": f.req_content_type.clone().unwrap_or_else(|| "application/octet-stream".to_string()),
                    "text": text,
                });
                if f.req_body_encoding == "base64" {
                    o["encoding"] = json!("base64");
                }
                o
            });
            let mut request = json!({
                "method": f.method,
                "url": flow_url(f),
                "httpVersion": if f.http_version.is_empty() { "HTTP/1.1".to_string() } else { f.http_version.clone() },
                "headers": har_headers(&f.req_headers),
                "queryString": [],
                "cookies": [],
                "headersSize": -1,
                "bodySize": f.req_size,
            });
            if let Some(pd) = post_data {
                request["postData"] = pd;
            }
            let mut content = json!({
                "size": f.res_size,
                "mimeType": f.res_content_type.clone().unwrap_or_default(),
                "text": f.res_body.clone().unwrap_or_default(),
            });
            if f.res_body_encoding == "base64" {
                content["encoding"] = json!("base64");
            }
            json!({
                "startedDateTime": epoch_ms_to_iso(f.started_at),
                "time": f.duration_ms.unwrap_or(0),
                "request": request,
                "response": {
                    "status": f.status.unwrap_or(0),
                    "statusText": f.status_text.clone().unwrap_or_default(),
                    "httpVersion": if f.http_version.is_empty() { "HTTP/1.1".to_string() } else { f.http_version.clone() },
                    "headers": har_headers(&f.res_headers),
                    "cookies": [],
                    "content": content,
                    "redirectURL": "",
                    "headersSize": -1,
                    "bodySize": f.res_size,
                },
                "cache": {},
                "timings": { "send": 0, "wait": f.duration_ms.unwrap_or(0), "receive": 0 },
            })
        })
        .collect();
    json!({ "log": { "version": "1.2", "creator": { "name": "Tucano Proxy", "version": SERVER_VERSION }, "entries": entries } })
}

fn tool_export_curl(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let include_headers = args.get("includeHeaders").and_then(|v| v.as_bool()).unwrap_or(true);
    let flows = fetch_flows(state, &flow_ids(&args));
    Ok(Value::Array(
        flows
            .iter()
            .map(|f| json!({ "id": f.id, "curl": flow_to_curl(f, include_headers) }))
            .collect(),
    ))
}

fn tool_export_code(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let lang = args.get("lang").and_then(|v| v.as_str()).unwrap_or("fetch");
    let flows = fetch_flows(state, &flow_ids(&args));
    Ok(Value::Array(
        flows
            .iter()
            .map(|f| json!({ "id": f.id, "code": flow_to_code(f, lang) }))
            .collect(),
    ))
}

fn tool_export_har(state: &Arc<AppState>, args: Value) -> Result<Value, String> {
    let flows = fetch_flows(state, &flow_ids(&args));
    Ok(flow_to_har(&flows))
}

// ─── tool catalog ─────────────────────────────────────────────────────────────

/// The advertised tool list. Mirrors the inputs accepted by the handlers above.
fn tools_list() -> Value {
    let pair = json!({ "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 2 });
    json!([
        {
            "name": "tucano_status",
            "description": "Get current Tucano Proxy status (running, port, captured flow count).",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tucano_list_flows",
            "description": "List captured HTTP flows (newest last). Returns summaries WITHOUT bodies. To search inside bodies/headers use tucano_search; to read a body use tucano_get_response_body. Combine filters to keep results (and tokens) small.",
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Max flows to return (newest kept). Omit = all matches." },
                "offset": { "type": "integer", "minimum": 0, "description": "Skip this many of the newest matches (for paging back through history)." },
                "host": { "type": "string", "description": "Substring match on host." },
                "method": { "type": "string", "description": "HTTP method (GET, POST, ...)." },
                "status": { "type": "integer", "description": "Exact response status code." },
                "statusClass": { "type": "string", "enum": ["1xx", "2xx", "3xx", "4xx", "5xx"], "description": "Match a whole status class, e.g. '5xx' for all server errors." },
                "statusMin": { "type": "integer", "description": "Minimum status code (inclusive)." },
                "statusMax": { "type": "integer", "description": "Maximum status code (inclusive)." },
                "contentType": { "type": "string", "description": "Substring match on request or response Content-Type, e.g. 'json'." },
                "path": { "type": "string", "description": "Substring match on the request path." },
                "clientApp": { "type": "string", "description": "Substring match on the originating client app." },
                "minDurationMs": { "type": "integer", "description": "Only flows that took at least this long (ms) — find slow calls." },
                "minSize": { "type": "integer", "description": "Only flows whose request or response is at least this many bytes." },
                "q": { "type": "string", "description": "Free-text match against host/path/method ONLY (not bodies — use tucano_search for that)." },
                "since": { "type": "integer", "description": "Only flows started at or after this epoch-millis timestamp. Use for incremental polling during automations." }
            }, "additionalProperties": false }
        },
        {
            "name": "tucano_get_flow",
            "description": "Get a single flow's full record. Bodies are included by default — pass includeBodies:false to get only metadata + headers (cheaper) when you don't need the payload.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "includeBodies": { "type": "boolean", "default": true, "description": "Set false to omit request/response bodies (metadata + headers only)." }
            }, "required": ["id"], "additionalProperties": false }
        },
        {
            "name": "tucano_get_request_body",
            "description": "Get just the request body of a flow. Returns at most maxBytes (default 64KB) starting at offset, with totalBytes + truncated so you can page large payloads instead of pulling them whole.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "maxBytes": { "type": "integer", "minimum": 1, "description": "Max bytes to return (default 65536). Keep small to save tokens." },
                "offset": { "type": "integer", "minimum": 0, "description": "Byte offset to start from (for paging)." },
                "select": { "type": "string", "description": "Extract a sub-value from a JSON body instead of returning the whole thing. Dot/bracket path, e.g. 'data.items[0].id' or 'data.items[*].name' ([*] fans out over an array). Huge token saver." }
            }, "required": ["id"], "additionalProperties": false }
        },
        {
            "name": "tucano_get_response_body",
            "description": "Get just the response body of a flow. Returns at most maxBytes (default 64KB) starting at offset, with totalBytes + truncated so you can page large payloads instead of pulling them whole.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "maxBytes": { "type": "integer", "minimum": 1, "description": "Max bytes to return (default 65536). Keep small to save tokens." },
                "offset": { "type": "integer", "minimum": 0, "description": "Byte offset to start from (for paging)." },
                "select": { "type": "string", "description": "Extract a sub-value from a JSON body instead of returning the whole thing. Dot/bracket path, e.g. 'data.items[0].id' or 'data.items[*].name' ([*] fans out over an array). Huge token saver." }
            }, "required": ["id"], "additionalProperties": false }
        },
        {
            "name": "tucano_replay_flow",
            "description": "Replay an existing flow, creating a new one. You can tweak just one header with setHeaders/removeHeaders (no need to fetch and resend the whole header list).",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "headers": { "type": "array", "description": "FULL header replacement as [name, value] tuples. Replaces ALL original headers. Prefer setHeaders/removeHeaders for small edits.", "items": pair },
                "setHeaders": { "type": "array", "description": "Override/add specific headers (case-insensitive by name); other original headers are kept.", "items": pair },
                "removeHeaders": { "type": "array", "description": "Remove these header names (case-insensitive); other original headers are kept.", "items": { "type": "string" } },
                "body": { "type": "string", "description": "Optional body override (utf8 or base64 — depends on content)." }
            }, "required": ["id"], "additionalProperties": false }
        },
        {
            "name": "tucano_compose_request",
            "description": "Send a brand-new HTTP request through Tucano. Returns the resulting flow.",
            "inputSchema": { "type": "object", "properties": {
                "method": { "type": "string" },
                "url": { "type": "string", "description": "Full URL including scheme." },
                "headers": { "type": "array", "items": pair },
                "body": { "type": "string" },
                "log": { "type": "boolean", "default": true, "description": "If false, the flow is sent but not persisted to the captures list." }
            }, "required": ["method", "url"], "additionalProperties": false }
        },
        {
            "name": "tucano_delete_flows",
            "description": "Delete flows by id.",
            "inputSchema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["ids"], "additionalProperties": false }
        },
        {
            "name": "tucano_clear_flows",
            "description": "Wipe ALL captured flows. Use at the start of an automation to establish a clean baseline.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tucano_start_capture",
            "description": "Turn on the local proxy AND flip the OS proxy so traffic actually reaches Tucano.",
            "inputSchema": { "type": "object", "properties": { "port": { "type": "integer", "description": "Proxy port. Defaults to current Tucano setting (usually 8888)." } }, "additionalProperties": false }
        },
        {
            "name": "tucano_stop_capture",
            "description": "Turn off the OS proxy and stop the local proxy server.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tucano_export_as_curl",
            "description": "Render one or more flows as ready-to-run curl commands. Useful for handing the captured traffic to a developer or to Claude Code to reimplement.",
            "inputSchema": { "type": "object", "properties": {
                "ids": { "type": "array", "items": { "type": "string" } },
                "includeHeaders": { "type": "boolean", "default": true, "description": "Include request headers (cookies, auth, etc)." }
            }, "required": ["ids"], "additionalProperties": false }
        },
        {
            "name": "tucano_export_as_code",
            "description": "Render one or more flows as code snippets in the chosen language/library.",
            "inputSchema": { "type": "object", "properties": {
                "ids": { "type": "array", "items": { "type": "string" } },
                "lang": { "type": "string", "enum": ["fetch", "axios", "python"], "default": "fetch", "description": "fetch (browser/Node), axios, or python (requests)." }
            }, "required": ["ids"], "additionalProperties": false }
        },
        {
            "name": "tucano_search",
            "description": "Full-text search INSIDE captured request/response bodies and headers (server-side). Returns matching flow ids + short snippets — far cheaper than downloading bodies to grep them yourself. Binary bodies are skipped.",
            "inputSchema": { "type": "object", "properties": {
                "q": { "type": "string", "description": "Text to search for." },
                "scope": { "type": "string", "enum": ["all", "body", "headers"], "default": "all", "description": "Where to look." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Max matching flows to return (default 50)." },
                "ignoreCase": { "type": "boolean", "default": true, "description": "Case-insensitive match." }
            }, "required": ["q"], "additionalProperties": false }
        },
        {
            "name": "tucano_stats",
            "description": "Aggregate stats over ALL captured flows: counts by status class / method / host / content-type, total bytes, error count, slowest and largest flows, time range. Use this instead of listing everything and counting in-context.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tucano_wait_for",
            "description": "Block until a flow matching the given filters is captured (or timeout). One cheap call instead of busy-polling tucano_list_flows. Trigger an action in the app, then wait for the resulting request here.",
            "inputSchema": { "type": "object", "properties": {
                "host": { "type": "string", "description": "Substring match on host." },
                "path": { "type": "string", "description": "Substring match on path." },
                "method": { "type": "string", "description": "HTTP method." },
                "status": { "type": "integer", "description": "Exact response status." },
                "since": { "type": "integer", "description": "Only match flows at/after this epoch-ms. Defaults to call time (only new traffic)." },
                "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000, "description": "Max wait in ms (default 15000, cap 60000)." }
            }, "additionalProperties": false }
        },
        {
            "name": "tucano_diff",
            "description": "Structured diff of two flows: changed request line / status / duration, and headers added / removed / changed, plus whether each body is identical. Cheaper than fetching both flows and diffing in-context.",
            "inputSchema": { "type": "object", "properties": { "a": { "type": "string", "description": "First flow id." }, "b": { "type": "string", "description": "Second flow id." } }, "required": ["a", "b"], "additionalProperties": false }
        },
        {
            "name": "tucano_get_ssl_settings",
            "description": "Get the current SSL-proxying settings (which HTTPS hosts get decrypted so their bodies are captured).",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "tucano_set_ssl_settings",
            "description": "Configure SSL proxying so HTTPS bodies for the hosts you care about are actually decrypted/captured. If a host isn't covered, its flows are tunneled (no body). Applies immediately to new traffic.",
            "inputSchema": { "type": "object", "properties": {
                "mode": { "type": "string", "enum": ["all", "allowlist", "blocklist"], "description": "all = decrypt everything; allowlist = only `hosts`; blocklist = everything except `hosts`." },
                "hosts": { "type": "array", "items": { "type": "string" }, "description": "Host patterns: exact, *.example.com, api.foo.*" },
                "skipHosts": { "type": "array", "items": { "type": "string" }, "description": "Hosts to always tunnel (never decrypt), regardless of mode." }
            }, "required": ["mode"], "additionalProperties": false }
        },
        {
            "name": "tucano_export_as_har",
            "description": "Export one or more flows as a standard HAR 1.2 log (importable into browsers, Postman, etc).",
            "inputSchema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["ids"], "additionalProperties": false }
        }
    ])
}
