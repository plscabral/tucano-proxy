use crate::ssl_settings::SslSettings;
use crate::state::AppState;
use crate::storage::Flow;
use crate::{proxy, system_proxy};
use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Emitter;

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub running: bool,
    pub port: u16,
    pub ca_installed: bool,
    pub system_proxy_on: bool,
    pub flows_count: usize,
}

#[tauri::command]
pub fn get_status(state: tauri::State<'_, Arc<AppState>>) -> Result<StatusDto, String> {
    let count = state.storage.lock().list().map(|v| v.len()).unwrap_or(0);
    Ok(StatusDto {
        running: state.running.load(Ordering::SeqCst),
        port: state.port.load(Ordering::SeqCst),
        ca_installed: state.ca.is_installed(),
        system_proxy_on: state.system_proxy_on.load(Ordering::SeqCst),
        flows_count: count,
    })
}

#[tauri::command]
pub async fn start_proxy(state: tauri::State<'_, Arc<AppState>>, port: u16) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) { return Ok(()); }
    state.port.store(port, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    *state.stop_tx.lock() = Some(tx);
    state.running.store(true, Ordering::SeqCst);
    let st: Arc<AppState> = state.inner().clone();
    tokio::spawn(async move {
        if let Err(e) = proxy::run(st.clone(), port, rx).await {
            tracing::error!("proxy error: {e}");
        }
        st.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn stop_proxy(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(tx) = state.stop_tx.lock().take() { let _ = tx.send(()); }
    state.running.store(false, Ordering::SeqCst);
    // Auto-revert the OS proxy: leaving it pointing at a stopped 127.0.0.1:8888
    // would break the user's internet.
    if state.system_proxy_on.load(Ordering::SeqCst) {
        let port = state.port.load(Ordering::SeqCst);
        let _ = system_proxy::set(false, port);
        state.system_proxy_on.store(false, Ordering::SeqCst);
    }
    Ok(())
}

/// Atomic "Start capturing": brings up the local proxy server AND flips the
/// OS-level system proxy so the user actually sees traffic. Mirrors the
/// Fiddler/Proxyman model — one click = ready to debug.
#[tauri::command]
pub async fn start_capture(state: tauri::State<'_, Arc<AppState>>, port: u16) -> Result<(), String> {
    // Start the proxy server (idempotent if already running).
    if !state.running.load(Ordering::SeqCst) {
        state.port.store(port, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        *state.stop_tx.lock() = Some(tx);
        state.running.store(true, Ordering::SeqCst);
        let st: Arc<AppState> = state.inner().clone();
        tokio::spawn(async move {
            if let Err(e) = proxy::run(st.clone(), port, rx).await {
                tracing::error!("proxy error: {e}");
            }
            st.running.store(false, Ordering::SeqCst);
        });
    }
    // Flip the OS proxy so traffic actually reaches us.
    // system_proxy::set() spawns child processes (networksetup, reg) — run it
    // in a blocking thread so the tokio runtime stays responsive.
    let active_port = state.port.load(Ordering::SeqCst);
    tokio::task::spawn_blocking(move || system_proxy::set(true, active_port))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
        .map_err(|e| { tracing::error!("system_proxy set failed: {e}"); format!("system proxy: {e}") })?;
    state.system_proxy_on.store(true, Ordering::SeqCst);
    Ok(())
}

/// Atomic "Stop capturing": tears down the OS proxy first (so the user's
/// internet is restored immediately) and then stops the local server.
#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let port = state.port.load(Ordering::SeqCst);
    if state.system_proxy_on.load(Ordering::SeqCst) {
        // system_proxy::set() spawns child processes — run off the async executor.
        tokio::task::spawn_blocking(move || system_proxy::set(false, port))
            .await
            .map_err(|e| format!("spawn_blocking: {e}"))?
            .map_err(|e| format!("system proxy: {e}"))?;
        state.system_proxy_on.store(false, Ordering::SeqCst);
    }
    if let Some(tx) = state.stop_tx.lock().take() { let _ = tx.send(()); }
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn install_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.ca.install_to_system().map_err(err)
}

#[tauri::command]
pub fn uninstall_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.ca.uninstall_from_system().map_err(err)
}

#[tauri::command]
pub fn export_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.ca.cert_pem.clone())
}

#[tauri::command]
pub fn toggle_system_proxy(state: tauri::State<'_, Arc<AppState>>, on: bool) -> Result<(), String> {
    let port = state.port.load(Ordering::SeqCst);
    system_proxy::set(on, port).map_err(err)?;
    state.system_proxy_on.store(on, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn clear_flows(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.storage.lock().clear().map_err(err)
}

#[tauri::command]
pub fn delete_flows(state: tauri::State<'_, Arc<AppState>>, ids: Vec<String>) -> Result<(), String> {
    state.storage.lock().delete_many(&ids).map_err(err)
}

#[tauri::command]
pub fn restore_flows(state: tauri::State<'_, Arc<AppState>>, flows: Vec<crate::storage::Flow>) -> Result<(), String> {
    let mut storage = state.storage.lock();
    for f in &flows {
        storage.upsert(f).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_flows(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Flow>, String> {
    state.storage.lock().list().map_err(err)
}

#[tauri::command]
pub fn get_flow(state: tauri::State<'_, Arc<AppState>>, id: String) -> Result<Option<Flow>, String> {
    state.storage.lock().get(&id).map_err(err)
}

#[tauri::command]
pub async fn replay_flow(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<String, String> {
    let flow = state.storage.lock().get(&id).map_err(err)?.ok_or("flow not found")?;
    send_request(state.inner().clone(), flow, headers, body, "Tucano Replay").await
}

#[tauri::command]
pub async fn compose_request(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    log: bool,
) -> Result<Flow, String> {
    // Parse URL into components for the Flow record.
    let uri: http::Uri = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let scheme = uri.scheme_str().unwrap_or("http").to_string();
    let host = uri.host().unwrap_or("").to_string();
    let port = uri.port_u16().unwrap_or(if scheme == "https" { 443 } else { 80 });
    let path = uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string());

    let template = Flow {
        id: uuid::Uuid::new_v4().to_string(),
        index: 0,
        started_at: 0,
        ended_at: None,
        method,
        scheme,
        host,
        port,
        path,
        http_version: "HTTP/1.1".to_string(),
        status: None,
        status_text: None,
        req_headers: headers.clone(),
        req_body: body.clone(),
        req_body_encoding: "utf8".to_string(),
        req_content_type: headers.iter().find(|(k, _)| k.to_lowercase() == "content-type").map(|(_, v)| v.clone()),
        req_size: body.as_ref().map(|b| b.len() as i64).unwrap_or(0),
        res_headers: vec![],
        res_body: None,
        res_body_encoding: "utf8".to_string(),
        res_content_type: None,
        res_size: 0,
        duration_ms: None,
        error: None,
        client_app: Some("Tucano Composer".to_string()),
        client_port: None,
        client_icon: None,
        note: None,
    };

    let new_id = send_request(state.inner().clone(), template, headers, body, "Tucano Composer").await?;
    let flow = state.storage.lock().get(&new_id).map_err(err)?.ok_or("flow not found after compose")?;
    if !log {
        // Remove from persistent storage but still return the result for inline display.
        let _ = state.storage.lock().delete_many(&[new_id]);
    }
    Ok(flow)
}

/// Shared HTTP sender used by replay_flow and compose_request.
async fn send_request(
    state: Arc<AppState>,
    flow: Flow,
    header_overrides: Vec<(String, String)>,
    body_override: Option<String>,
    source_label: &'static str,
) -> Result<String, String> {
    let url_str = format!("{}://{}:{}{}", flow.scheme, flow.host, flow.port, flow.path);
    let uri: http::Uri = url_str.parse().map_err(|e| format!("bad uri: {e}"))?;
    let method = http::Method::from_bytes(flow.method.as_bytes()).map_err(err)?;

    // Header overrides replace the originals when provided.
    let req_headers = if !header_overrides.is_empty() { header_overrides } else { flow.req_headers.clone() };

    // Body: use override if provided, else original.
    let body_src = body_override.or_else(|| flow.req_body.clone());
    let body_bytes: Bytes = match body_src {
        Some(b) if flow.req_body_encoding == "base64" => {
            base64::engine::general_purpose::STANDARD.decode(&b).unwrap_or_default().into()
        }
        Some(b) => b.into_bytes().into(),
        None => Bytes::new(),
    };

    let mut req_builder = http::Request::builder().method(method).uri(uri);
    for (k, v) in &req_headers {
        req_builder = req_builder.header(k.as_str(), v.as_str());
    }
    let req = req_builder.body(Full::new(body_bytes.clone())).map_err(err)?;

    let connector = crate::http_client::build_connector().map_err(err)?;
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .http1_title_case_headers(true)
        .http1_preserve_header_case(true)
        .build(connector);

    let started_at = proxy::now_ms();
    let res = client.request(req).await.map_err(err)?;
    let ended_at = proxy::now_ms();

    let (res_parts, res_body) = res.into_parts();
    let raw_bytes = res_body.collect().await.map_err(err)?.to_bytes();
    let res_enc = proxy::content_encoding(&res_parts.headers);
    let display_bytes = proxy::decompress(&raw_bytes, res_enc.as_deref());
    let res_ct = proxy::content_type(&res_parts.headers);
    let (res_body_str, res_enc_str) = proxy::encode_body(&display_bytes, res_ct.as_deref());

    let idx = state.storage.lock().next_index();
    let req_ct = req_headers.iter().find(|(k, _)| k.to_lowercase() == "content-type").map(|(_, v)| v.clone());
    let (req_body_str, req_enc_str) = if body_bytes.is_empty() {
        (None, "utf8")
    } else {
        let (s, e) = proxy::encode_body(&body_bytes, req_ct.as_deref());
        (Some(s), e)
    };

    let new_flow = Flow {
        id: uuid::Uuid::new_v4().to_string(),
        index: idx,
        started_at,
        ended_at: Some(ended_at),
        method: flow.method.clone(),
        scheme: flow.scheme.clone(),
        host: flow.host.clone(),
        port: flow.port,
        path: flow.path.clone(),
        http_version: flow.http_version.clone(),
        status: Some(res_parts.status.as_u16() as i64),
        status_text: res_parts.status.canonical_reason().map(|s| s.to_string()),
        req_headers,
        req_body: req_body_str,
        req_body_encoding: req_enc_str.to_string(),
        req_content_type: req_ct,
        req_size: body_bytes.len() as i64,
        res_headers: proxy::headers_to_vec(&res_parts.headers),
        res_body: Some(res_body_str),
        res_body_encoding: res_enc_str.to_string(),
        res_content_type: res_ct,
        res_size: display_bytes.len() as i64,
        duration_ms: Some(ended_at - started_at),
        error: None,
        client_app: Some(source_label.to_string()),
        client_port: None,
        client_icon: None,
        note: Some(format!("#{} via {source_label}", flow.index)),
    };

    let new_id = new_flow.id.clone();
    let _ = state.app.emit("flow:new", &new_flow);
    state.storage.lock().upsert(&new_flow).map_err(err)?;
    let _ = state.app.emit("flow:update", &new_flow);
    Ok(new_id)
}

#[tauri::command]
pub fn get_keep_limit(state: tauri::State<'_, Arc<AppState>>) -> usize {
    state.keep_limit.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_keep_limit(state: tauri::State<'_, Arc<AppState>>, limit: usize) -> Result<(), String> {
    state.keep_limit.store(limit, Ordering::Relaxed);
    if limit > 0 {
        let trimmed = state.storage.lock().trim_to_limit(limit);
        if !trimmed.is_empty() {
            let _ = state.app.emit("flows:trimmed", &trimmed);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_flow_note(state: tauri::State<'_, Arc<AppState>>, id: String, note: Option<String>) -> Result<(), String> {
    let mut storage = state.storage.lock();
    let mut flow = storage.get(&id).map_err(err)?.ok_or_else(|| "flow not found".to_string())?;
    flow.note = note.filter(|n| !n.is_empty());
    storage.upsert(&flow).map_err(err)?;
    let _ = state.app.emit("flow:update", &flow);
    Ok(())
}

/// Quit the entire process — called by the frontend AFTER the user
/// confirmed the "Quit Tucano?" dialog. Runs cleanup (revert system proxy,
/// stop the proxy task) and then hard-exits via `process::exit`. We avoid
/// `AppHandle::exit` here because in Tauri 2 that fires `RunEvent::ExitRequested`,
/// which we deliberately prevent in the run loop (so Cmd+Q doesn't bypass
/// the confirm dialog) — using it would loop forever.
#[tauri::command]
pub fn quit_app(state: tauri::State<'_, Arc<AppState>>) {
    crate::cleanup_state(&state);
    std::process::exit(0);
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(err)
}

#[tauri::command]
pub fn write_binary_file(path: String, contents_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(err)?;
    std::fs::write(&path, bytes).map_err(err)
}

#[tauri::command]
pub fn save_session(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    let storage = state.storage.lock();
    let dest = PathBuf::from(path);
    match ids {
        Some(ids) => storage.save_subset_to(&dest, &ids).map_err(err),
        None => storage.save_to(&dest).map_err(err),
    }
}

#[tauri::command]
pub fn open_session(state: tauri::State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    state.storage.lock().replace_from(&PathBuf::from(path)).map_err(err)
}

#[tauri::command]
pub fn get_ssl_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<SslSettings, String> {
    Ok(state.ssl.lock().clone())
}


#[tauri::command]
pub fn set_ssl_settings(state: tauri::State<'_, Arc<AppState>>, settings: SslSettings) -> Result<(), String> {
    settings.save(&state.data_dir).map_err(err)?;
    *state.ssl.lock() = settings;
    Ok(())
}
