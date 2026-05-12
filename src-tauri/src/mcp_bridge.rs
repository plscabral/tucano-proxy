use crate::state::AppState;
use axum::{
    extract::{Path as AxPath, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

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
        .route("/flows", get(list_flows).delete(delete_flows_handler))
        .route("/flows/:id", get(get_flow_handler))
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

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let count = state.storage.lock().list().map(|v| v.len()).unwrap_or(0);
    Json(json!({
        "running": state.running.load(Ordering::SeqCst),
        "port": state.port.load(Ordering::SeqCst),
        "systemProxyOn": state.system_proxy_on.load(Ordering::SeqCst),
        "flowsCount": count,
    }))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<usize>,
    host: Option<String>,
    method: Option<String>,
    status: Option<i64>,
    q: Option<String>,
    /// Only return flows started at or after this epoch-millis timestamp.
    /// Cheap "watch for new traffic" loop for LLM automations.
    since: Option<i64>,
}

async fn list_flows(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Response {
    let flows = match state.storage.lock().list() {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let needle = q.q.as_ref().map(|s| s.to_lowercase());
    let mut filtered: Vec<_> = flows
        .into_iter()
        .filter(|f| {
            if let Some(h) = &q.host {
                if !f.host.to_lowercase().contains(&h.to_lowercase()) { return false; }
            }
            if let Some(m) = &q.method {
                if !f.method.eq_ignore_ascii_case(m) { return false; }
            }
            if let Some(s) = q.status {
                if f.status != Some(s) { return false; }
            }
            if let Some(ts) = q.since {
                if f.started_at < ts { return false; }
            }
            if let Some(n) = &needle {
                let hay = format!("{} {} {}", f.host, f.path, f.method).to_lowercase();
                if !hay.contains(n) { return false; }
            }
            true
        })
        .collect();
    // Keep newest N when limit is set (flows come ordered by idx ASC).
    if let Some(l) = q.limit {
        let total = filtered.len();
        if total > l { filtered.drain(0..total - l); }
    }
    // Strip bodies — list responses can be MBs otherwise and the LLM rarely
    // needs them at this stage. Callers fetch full bodies via /flows/:id.
    let summaries: Vec<Value> = filtered.iter().map(|f| json!({
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
    })).collect();
    Json(summaries).into_response()
}

async fn get_flow_handler(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Response {
    match state.storage.lock().get(&id) {
        Ok(Some(f)) => Json(f).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "flow not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

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
struct ReplayBody {
    #[serde(default)]
    headers: Vec<(String, String)>,
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
    match crate::commands::send_request(state, flow, body.headers, body.body, "MCP Replay").await {
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

fn default_true() -> bool { true }

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
