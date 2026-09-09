use crate::{
    mcp_settings::McpSettings,
    proxy,
    ssl_settings::SslSettings,
    state::{AppState, Lifecycle},
    storage::{Flow, FlowState},
    system_proxy,
};
use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    pub running: bool,
    pub port: u16,
    pub ca_installed: bool,
    pub system_proxy_on: bool,
    pub flows_count: usize,
}
pub fn get_status(state: Arc<AppState>) -> Result<StatusDto, String> {
    Ok(StatusDto {
        running: state.running.load(Ordering::SeqCst),
        port: state.port.load(Ordering::SeqCst),
        ca_installed: state.ca.is_installed(),
        system_proxy_on: state.system_proxy_on.load(Ordering::SeqCst),
        flows_count: state.storage.lock().count().map_err(err)?,
    })
}
async fn start_locked(
    state: &Arc<AppState>,
    port: u16,
    lifecycle: &mut Lifecycle,
) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        return if state.port.load(Ordering::SeqCst) == port || port == 0 {
            Ok(())
        } else {
            Err("proxy already running on another port".into())
        };
    }
    if state.system_proxy_on.load(Ordering::SeqCst) || system_proxy::owns(&state.data_dir) {
        let dir = state.data_dir.clone();
        tokio::task::spawn_blocking(move || system_proxy::restore(&dir))
            .await
            .map_err(err)?
            .map_err(err)?;
        state.system_proxy_on.store(false, Ordering::SeqCst);
    }
    if let Some(task) = state.proxy_task.lock().take() {
        task.abort();
    }
    *lifecycle = Lifecycle::Starting;
    let listener = match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
    {
        Ok(listener) => listener,
        Err(e) => {
            // A port already held by another session (or any other process) is the
            // common failure here; the bare OS text leaves the user guessing.
            let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is already in use by another process, commonly a second Tucano Proxy session. Choose a free capture port, or stop the service that owns this one.")
            } else {
                e.to_string()
            };
            *lifecycle = Lifecycle::Failed(message.clone());
            return Err(message);
        }
    };
    let actual = listener.local_addr().map_err(err)?.port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let run = proxy::prepare(state.clone(), listener, rx).map_err(|error| {
        *lifecycle = Lifecycle::Failed(error.to_string());
        error.to_string()
    })?;
    let generation = state.proxy_generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.stop_tx.lock() = Some(tx);
    state.port.store(actual, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);
    let st = state.clone();
    *state.proxy_task.lock() = Some(tokio::spawn(async move {
        let result = run.await;
        st.running.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            let error = error.to_string();
            let _ = st.emit("proxy:error", &error);
            let recovery = st.clone();
            tokio::spawn(async move {
                let mut lifecycle = recovery.lifecycle.lock().await;
                if recovery.proxy_generation.load(Ordering::SeqCst) == generation {
                    if let Err(restore) = stop_locked(&recovery, &mut lifecycle).await {
                        let _ = recovery.emit("proxy:error", restore);
                    }
                    *lifecycle = Lifecycle::Failed(error);
                }
            });
        }
        let _ = st.emit(
            "proxy:status",
            serde_json::json!({"running":false,"port":st.port.load(Ordering::SeqCst)}),
        );
    }));
    *lifecycle = Lifecycle::Running;
    state.emit(
        "proxy:status",
        serde_json::json!({"running":true,"port":actual}),
    )?;
    Ok(())
}
async fn stop_locked(state: &Arc<AppState>, lifecycle: &mut Lifecycle) -> Result<(), String> {
    *lifecycle = Lifecycle::Stopping;
    state.proxy_generation.fetch_add(1, Ordering::SeqCst);
    if state.system_proxy_on.load(Ordering::SeqCst) || system_proxy::owns(&state.data_dir) {
        let dir = state.data_dir.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || system_proxy::restore(&dir))
            .await
            .map_err(err)?
            .map_err(err)
        {
            *lifecycle = Lifecycle::Failed(error.clone());
            return Err(error);
        }
        state.system_proxy_on.store(false, Ordering::SeqCst);
    }
    state.proxy_connections.lock().cancel();
    {
        let _gate = state.capture_gate.lock();
        state.generation.fetch_add(1, Ordering::SeqCst);
        state
            .storage
            .lock()
            .finalize_pending("proxy stopped before capture completed")
            .map_err(err)?;
        state.emit("flows:reset", ())?;
    }
    if let Some(tx) = state.stop_tx.lock().take() {
        let _ = tx.send(());
    }
    let task = state.proxy_task.lock().take();
    if let Some(mut task) = task {
        if tokio::time::timeout(std::time::Duration::from_secs(3), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
    state.running.store(false, Ordering::SeqCst);
    *lifecycle = Lifecycle::Stopped;
    state.emit(
        "proxy:status",
        serde_json::json!({"running":false,"port":state.port.load(Ordering::SeqCst)}),
    )?;
    Ok(())
}
pub async fn start_proxy(state: Arc<AppState>, port: u16) -> Result<(), String> {
    let mut lifecycle = state.lifecycle.lock().await;
    start_locked(&state, port, &mut lifecycle).await
}
pub async fn stop_proxy(state: Arc<AppState>) -> Result<(), String> {
    let mut lifecycle = state.lifecycle.lock().await;
    stop_locked(&state, &mut lifecycle).await
}
pub async fn start_capture(state: Arc<AppState>, port: u16) -> Result<(), String> {
    start_capture_internal(state, port).await
}
pub async fn start_capture_internal(state: Arc<AppState>, port: u16) -> Result<(), String> {
    let mut lifecycle = state.lifecycle.lock().await;
    start_locked(&state, port, &mut lifecycle).await?;
    let dir = state.data_dir.clone();
    let port = state.port.load(Ordering::SeqCst);
    if let Err(error) = tokio::task::spawn_blocking(move || system_proxy::enable(&dir, port))
        .await
        .map_err(err)?
        .map_err(err)
    {
        let dir = state.data_dir.clone();
        let rollback = tokio::task::spawn_blocking(move || system_proxy::restore(&dir))
            .await
            .map_err(err)?
            .map_err(err);
        if let Err(restore) = rollback {
            state.system_proxy_on.store(true, Ordering::SeqCst);
            return Err(format!("{error}; restoring system proxy: {restore}"));
        }
        stop_locked(&state, &mut lifecycle).await?;
        return Err(error);
    }
    state.system_proxy_on.store(true, Ordering::SeqCst);
    Ok(())
}
pub async fn stop_capture(state: Arc<AppState>) -> Result<(), String> {
    stop_proxy(state).await
}
pub async fn stop_capture_internal(state: Arc<AppState>) -> Result<(), String> {
    stop_proxy(state).await
}
pub async fn toggle_system_proxy(state: Arc<AppState>, on: bool) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    if on && !state.running.load(Ordering::SeqCst) {
        return Err("start the proxy before enabling system proxy".into());
    }
    let dir = state.data_dir.clone();
    let port = state.port.load(Ordering::SeqCst);
    let result = tokio::task::spawn_blocking(move || {
        if on {
            system_proxy::enable(&dir, port)
        } else {
            system_proxy::restore(&dir)
        }
    })
    .await
    .map_err(err)?
    .map_err(err);
    state
        .system_proxy_on
        .store(system_proxy::owns(&state.data_dir), Ordering::SeqCst);
    result
}
pub fn install_ca(state: Arc<AppState>) -> Result<(), String> {
    state.ca.install_to_system().map_err(err)
}
pub fn uninstall_ca(state: Arc<AppState>) -> Result<(), String> {
    state.ca.uninstall_from_system().map_err(err)
}
pub fn export_ca(state: Arc<AppState>) -> Result<String, String> {
    Ok(state.ca.cert_pem.clone())
}
pub fn get_private_mode(state: Arc<AppState>) -> bool {
    state.private_mode.load(Ordering::SeqCst)
}
pub fn set_private_mode(state: Arc<AppState>, enabled: bool) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    if enabled {
        state.storage.lock().clear().map_err(err)?;
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.private_mode.store(enabled, Ordering::SeqCst);
    state.save_preferences()?;
    state.emit("flows:reset", ())?;
    Ok(())
}
pub fn clear_flows(state: Arc<AppState>) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    state.storage.lock().clear().map_err(err)?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.emit("flows:reset", ())
}
pub fn delete_flows(state: Arc<AppState>, ids: Vec<String>) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    state.storage.lock().delete_many(&ids).map_err(err)?;
    state.emit("flows:trimmed", ids)
}
pub fn restore_flows(state: Arc<AppState>, flows: Vec<Flow>) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    if state.private_mode.load(Ordering::SeqCst) {
        return Err("private mode prohibits retained captures".into());
    }
    let mut storage = state.storage.lock();
    storage.restore_many(&flows).map_err(err)?;
    state
        .next_flow_index
        .fetch_max(storage.next_index().map_err(err)? as u64, Ordering::SeqCst);
    state.emit("flows:reset", ())
}
pub fn list_flows(state: Arc<AppState>) -> Result<Vec<Flow>, String> {
    state.storage.lock().list().map_err(err)
}
pub fn get_flow(state: Arc<AppState>, id: String) -> Result<Option<Flow>, String> {
    state.storage.lock().get(&id).map_err(err)
}
pub fn get_keep_limit(state: Arc<AppState>) -> usize {
    state.keep_limit.load(Ordering::Relaxed)
}
pub fn set_keep_limit(state: Arc<AppState>, limit: usize) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    state.keep_limit.store(limit, Ordering::Relaxed);
    state.save_preferences()?;
    if limit > 0 {
        let ids = state.storage.lock().trim_to_limit(limit)?;
        if !ids.is_empty() {
            state.emit("flows:trimmed", ids)?;
        }
    }
    Ok(())
}
pub fn update_flow_note(
    state: Arc<AppState>,
    id: String,
    note: Option<String>,
) -> Result<(), String> {
    update_annotation(state, id, note, false)
}
pub fn update_flow_mark(
    state: Arc<AppState>,
    id: String,
    mark: Option<String>,
) -> Result<(), String> {
    update_annotation(state, id, mark, true)
}
fn update_annotation(
    state: Arc<AppState>,
    id: String,
    value: Option<String>,
    mark: bool,
) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    let mut storage = state.storage.lock();
    let mut flow = storage.get(&id).map_err(err)?.ok_or("flow not found")?;
    if mark {
        flow.mark = value.filter(|s| !s.is_empty());
    } else {
        flow.note = value.filter(|s| !s.is_empty());
    }
    storage.upsert(&flow).map_err(err)?;
    state.emit("flow:update", flow)
}
pub fn save_session(
    state: Arc<AppState>,
    path: String,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    let dest = PathBuf::from(path);
    let storage = state.storage.lock();
    if let Some(ids) = ids {
        storage.save_subset_to(&dest, &ids).map_err(err)
    } else {
        storage.save_to(&dest).map_err(err)
    }
}
pub fn open_session(state: Arc<AppState>, path: String) -> Result<(), String> {
    let _gate = state.capture_gate.lock();
    if state.private_mode.load(Ordering::SeqCst) {
        return Err("private mode prohibits session imports".into());
    }
    let mut storage = state.storage.lock();
    storage.replace_from(&PathBuf::from(path)).map_err(err)?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    state
        .next_flow_index
        .fetch_max(storage.next_index().map_err(err)? as u64, Ordering::SeqCst);
    state.emit("flows:reset", ())
}
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(err)
}
pub fn write_binary_file(path: String, contents_base64: String) -> Result<(), String> {
    std::fs::write(
        path,
        base64::engine::general_purpose::STANDARD
            .decode(contents_base64)
            .map_err(err)?,
    )
    .map_err(err)
}
pub fn get_ssl_settings(state: Arc<AppState>) -> Result<SslSettings, String> {
    Ok(state.ssl.lock().clone())
}
pub fn set_ssl_settings(state: Arc<AppState>, settings: SslSettings) -> Result<(), String> {
    if !matches!(settings.mode.as_str(), "all" | "allowlist" | "blocklist") {
        return Err("invalid SSL mode".into());
    }
    if settings.insecure_hosts.iter().any(|host| {
        host.is_empty() || host.contains('*') || host.contains('/') || host.contains(' ')
    }) {
        return Err(
            "insecureHosts must contain exact hostnames or IP addresses, never wildcards".into(),
        );
    }
    // Serialize persistence, verifier policy and the connection revocation boundary.
    // New connectors cannot obtain a token for the next generation until this completes.
    let mut policy = state.tls_policy.lock();
    settings.save(&state.data_dir).map_err(err)?;
    let mut ssl = state.ssl.lock();
    let changed = ssl.insecure_hosts != settings.insecure_hosts;
    *ssl = settings;
    if changed {
        policy.cancel();
        *policy = tokio_util::sync::CancellationToken::new();
    }
    Ok(())
}
pub fn get_mcp_settings(state: Arc<AppState>) -> McpSettings {
    state.mcp_settings.lock().clone()
}
pub async fn set_mcp_settings(
    state: Arc<AppState>,
    mut settings: McpSettings,
) -> Result<(), String> {
    if settings.port == 0 || settings.token.len() < 16 {
        return Err("MCP requires a port and token of at least 16 characters".into());
    }
    let _guard = state.mcp_lifecycle.lock().await;
    let previous = state.mcp_settings.lock().clone();
    settings.runtime_data_dir = Some(state.data_dir.clone());
    crate::mcp_bridge::stop_unlocked(&state).await;
    if settings.enabled {
        if let Err(error) =
            crate::mcp_bridge::spawn_unlocked(state.clone(), settings.port, settings.token.clone())
                .await
        {
            if previous.enabled {
                crate::mcp_bridge::spawn_unlocked(
                    state.clone(),
                    previous.port,
                    previous.token.clone(),
                )
                .await?;
            }
            return Err(error);
        }
    }
    if let Err(error) = settings
        .save(&state.data_dir)
        .map_err(err)
        .and_then(|_| crate::mcp_install::refresh_installed(&settings))
    {
        crate::mcp_bridge::stop_unlocked(&state).await;
        if previous.enabled {
            crate::mcp_bridge::spawn_unlocked(state.clone(), previous.port, previous.token.clone())
                .await?;
        }
        previous.save(&state.data_dir).map_err(err)?;
        return Err(error);
    }
    *state.mcp_settings.lock() = settings;
    Ok(())
}
pub async fn rotate_mcp_token(state: Arc<AppState>) -> Result<McpSettings, String> {
    let mut settings = state.mcp_settings.lock().clone();
    settings.token = crate::mcp_settings::new_token();
    set_mcp_settings(state, settings.clone()).await?;
    Ok(settings)
}
pub async fn replay_flow(
    state: Arc<AppState>,
    id: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<String, String> {
    let flow = state
        .storage
        .lock()
        .get(&id)
        .map_err(err)?
        .ok_or("flow not found")?;
    send_request(state, flow, headers, body, "Tucano Replay").await
}
pub async fn compose_request(
    state: Arc<AppState>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    log: bool,
) -> Result<Flow, String> {
    compose_internal(state, method, url, headers, body, log).await
}
pub async fn compose_internal(
    state: Arc<AppState>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    log: bool,
) -> Result<Flow, String> {
    let uri: http::Uri = url.parse().map_err(err)?;
    let scheme = uri.scheme_str().ok_or("absolute HTTP URL required")?;
    if !matches!(scheme, "http" | "https") {
        return Err("only HTTP and HTTPS URLs are supported".into());
    }
    let host = uri.host().ok_or("URL host required")?.to_string();
    let port = uri
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    let flow = proxy::empty_flow(
        &state,
        method,
        scheme.into(),
        host,
        port,
        uri.path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/")
            .into(),
    );
    send(state, flow, headers, body, "Tucano Composer", log).await
}
pub async fn send_request(
    state: Arc<AppState>,
    flow: Flow,
    headers: Vec<(String, String)>,
    body: Option<String>,
    source: &'static str,
) -> Result<String, String> {
    Ok(send(state, flow, headers, body, source, true).await?.id)
}
fn replay_body(flow: &Flow, body_override: Option<String>) -> Result<Bytes, String> {
    if let Some(body) = body_override {
        return Ok(Bytes::from(body));
    }
    if flow.req_truncated {
        return Err("request body was truncated; provide a complete replacement body".into());
    }
    let Some(body) = &flow.req_body else {
        return Ok(Bytes::new());
    };
    if body.contains("[REDACTED") {
        return Err("request body was redacted; provide a replacement body".into());
    }
    if flow.req_body_encoding == "base64" {
        return base64::engine::general_purpose::STANDARD
            .decode(body)
            .map(Bytes::from)
            .map_err(err);
    }
    Ok(Bytes::copy_from_slice(body.as_bytes()))
}
async fn send(
    state: Arc<AppState>,
    template: Flow,
    header_overrides: Vec<(String, String)>,
    body_override: Option<String>,
    source: &'static str,
    log: bool,
) -> Result<Flow, String> {
    let generation = state.capture_generation();
    if template.path.contains("[REDACTED")
        || template.path.to_ascii_uppercase().contains("%5BREDACTED")
    {
        return Err(
            "request URL was redacted; compose a new request with explicit credentials".into(),
        );
    }
    let replaced_body = body_override.is_some();
    let body = replay_body(&template, body_override)?;
    let mut headers = header_overrides;
    if headers.iter().any(|(_, v)| v.contains("[REDACTED")) {
        return Err(
            "request headers contain redacted credentials; replace or remove them explicitly"
                .into(),
        );
    }
    headers.retain(|(k, _)| {
        let connection_header = [
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "proxy-connection",
            "proxy-authorization",
            "keep-alive",
            "te",
            "trailer",
            "upgrade",
        ]
        .iter()
        .any(|name| k.eq_ignore_ascii_case(name));
        !(connection_header || replaced_body && k.eq_ignore_ascii_case("content-encoding"))
    });
    let host = if template.host.contains(':') && !template.host.starts_with('[') {
        format!("[{}]", template.host)
    } else {
        template.host.clone()
    };
    let url = format!(
        "{}://{}:{}{}",
        template.scheme, host, template.port, template.path
    );
    let mut builder = http::Request::builder()
        .method(http::Method::from_bytes(template.method.as_bytes()).map_err(err)?)
        .uri(url.as_str());
    for (k, v) in &headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let req = builder.body(Full::new(body.clone())).map_err(err)?;
    let mut flow = proxy::empty_flow(
        &state,
        template.method,
        template.scheme,
        template.host,
        template.port,
        template.path,
    );
    flow.req_headers = headers;
    flow.req_content_type = flow
        .req_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.clone());
    let retained = body.slice(..body.len().min(proxy::MAX_RAW_BODY_BYTES));
    let (value, encoding) = proxy::encode_body(&retained, flow.req_content_type.as_deref());
    flow.req_body = (!body.is_empty()).then_some(value);
    flow.req_body_encoding = encoding.into();
    flow.req_size = body.len() as i64;
    flow.req_truncated = body.len() > retained.len();
    flow.client_app = Some(source.into());
    flow.note = (template.index > 0).then(|| format!("#{} via {source}", template.index));
    if log {
        state.retain(&flow, generation, "flow:new")?;
    }
    let connector = crate::http_client::build_connector_for(Some(state.clone())).map_err(err)?;
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build(connector);
    let result: Result<(), String> = async {
        let res = tokio::time::timeout(std::time::Duration::from_secs(120), client.request(req))
            .await
            .map_err(err)?
            .map_err(err)?;
        let (parts, mut response) = res.into_parts();
        flow.status = Some(parts.status.as_u16() as i64);
        flow.status_text = parts.status.canonical_reason().map(str::to_owned);
        flow.res_headers = proxy::headers_to_vec(&parts.headers);
        flow.res_content_type = proxy::content_type(&parts.headers);
        flow.state = FlowState::Streaming;
        if log {
            state.retain(&flow, generation, "flow:update")?;
        }
        let mut raw = Vec::new();
        while let Some(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(120), response.frame())
                .await
                .map_err(err)?
        {
            if let Some(data) = frame.map_err(err)?.data_ref() {
                flow.res_size += data.len() as i64;
                let remain = proxy::MAX_RAW_BODY_BYTES.saturating_sub(raw.len());
                raw.extend_from_slice(&data[..remain.min(data.len())]);
            }
        }
        flow.res_truncated = flow.res_size > raw.len() as i64;
        let (display, truncated) = proxy::decompress(
            &Bytes::from(raw),
            proxy::content_encoding(&parts.headers).as_deref(),
        );
        flow.res_truncated |= truncated;
        let (value, encoding) = proxy::encode_body(&display, flow.res_content_type.as_deref());
        flow.res_body = (!display.is_empty()).then_some(value);
        flow.res_body_encoding = encoding.into();
        Ok(())
    }
    .await;
    let end = proxy::now_ms();
    flow.ended_at = Some(end);
    flow.duration_ms = Some(end - flow.started_at);
    flow.error = result.as_ref().err().cloned();
    flow.state = if flow.error.is_some() {
        FlowState::Error
    } else if flow.req_truncated || flow.res_truncated {
        FlowState::Truncated
    } else {
        FlowState::Complete
    };
    crate::storage::redact_flow(&mut flow);
    if log {
        state.retain(&flow, generation, "flow:update")?;
    }
    result?;
    Ok(flow)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_body_is_utf8_even_when_original_is_base64() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let mut flow = proxy::empty_flow(
            &state,
            "POST".into(),
            "http".into(),
            "example.test".into(),
            80,
            "/".into(),
        );
        flow.req_body_encoding = "base64".into();
        flow.req_body = Some("AAEC".into());
        assert_eq!(replay_body(&flow, None).unwrap().as_ref(), &[0, 1, 2]);
        assert_eq!(
            replay_body(&flow, Some("plain replacement".into()))
                .unwrap()
                .as_ref(),
            b"plain replacement"
        );
        flow.req_body = Some("[REDACTED BINARY BODY]".into());
        assert!(replay_body(&flow, None).unwrap_err().contains("redacted"));
        flow.req_body = Some("invalid base64!".into());
        assert!(replay_body(&flow, None).is_err());
        flow.req_truncated = true;
        assert!(replay_body(&flow, None).unwrap_err().contains("truncated"));
    }
}
