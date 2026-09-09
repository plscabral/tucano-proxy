use serde_json::{json, Value};
use std::sync::Arc;
use tucano_core::state::AppState;

#[tauri::command]
pub async fn get_status(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_status", json!({})).await
}

#[tauri::command]
pub async fn start_proxy(
    state: tauri::State<'_, Arc<AppState>>,
    port: u16,
) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "start_proxy", json!({"port": port})).await
}

#[tauri::command]
pub async fn stop_proxy(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "stop_proxy", json!({})).await
}

#[tauri::command]
pub async fn start_capture(
    state: tauri::State<'_, Arc<AppState>>,
    port: u16,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "start_capture",
        json!({"port": port}),
    )
    .await
}

#[tauri::command]
pub async fn stop_capture(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "stop_capture", json!({})).await
}

#[tauri::command]
pub async fn install_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "install_ca", json!({})).await
}

#[tauri::command]
pub async fn uninstall_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "uninstall_ca", json!({})).await
}

#[tauri::command]
pub async fn export_ca(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "export_ca", json!({})).await
}

#[tauri::command]
pub async fn toggle_system_proxy(
    state: tauri::State<'_, Arc<AppState>>,
    on: bool,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "toggle_system_proxy",
        json!({"on": on}),
    )
    .await
}

#[tauri::command]
pub async fn get_private_mode(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_private_mode", json!({})).await
}

#[tauri::command]
pub async fn set_private_mode(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "set_private_mode",
        json!({"enabled": enabled}),
    )
    .await
}

#[tauri::command]
pub async fn clear_flows(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "clear_flows", json!({})).await
}

#[tauri::command]
pub async fn delete_flows(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<String>,
) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "delete_flows", json!({"ids": ids})).await
}

#[tauri::command]
pub async fn restore_flows(
    state: tauri::State<'_, Arc<AppState>>,
    flows: Vec<tucano_core::storage::Flow>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "restore_flows",
        json!({"flows": flows}),
    )
    .await
}

#[tauri::command]
pub async fn list_flows(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "list_flows", json!({})).await
}

#[tauri::command]
pub async fn get_flow(state: tauri::State<'_, Arc<AppState>>, id: String) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_flow", json!({"id": id})).await
}

#[tauri::command]
pub async fn update_flow_note(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    note: Option<String>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "update_flow_note",
        json!({"id": id, "note": note}),
    )
    .await
}

#[tauri::command]
pub async fn update_flow_mark(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    mark: Option<String>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "update_flow_mark",
        json!({"id": id, "mark": mark}),
    )
    .await
}

#[tauri::command]
pub async fn replay_flow(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "replay_flow",
        json!({"id": id, "headers": headers, "body": body}),
    )
    .await
}

#[tauri::command]
pub async fn compose_request(
    state: tauri::State<'_, Arc<AppState>>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    log: bool,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "compose_request",
        json!({"method": method, "url": url, "headers": headers, "body": body, "log": log}),
    )
    .await
}

#[tauri::command]
pub async fn save_session(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    ids: Option<Vec<String>>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "save_session",
        json!({"path": path, "ids": ids}),
    )
    .await
}

#[tauri::command]
pub async fn open_session(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "open_session", json!({"path": path})).await
}

#[tauri::command]
pub async fn write_text_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    contents: String,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "write_text_file",
        json!({"path": path, "contents": contents}),
    )
    .await
}

#[tauri::command]
pub async fn write_binary_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    contents_base64: String,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "write_binary_file",
        json!({"path": path, "contentsBase64": contents_base64}),
    )
    .await
}

#[tauri::command]
pub async fn get_ssl_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_ssl_settings", json!({})).await
}

#[tauri::command]
pub async fn set_ssl_settings(
    state: tauri::State<'_, Arc<AppState>>,
    settings: tucano_core::ssl_settings::SslSettings,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "set_ssl_settings",
        json!({"settings": settings}),
    )
    .await
}

#[tauri::command]
pub async fn get_keep_limit(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_keep_limit", json!({})).await
}

#[tauri::command]
pub async fn set_keep_limit(
    state: tauri::State<'_, Arc<AppState>>,
    limit: usize,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "set_keep_limit",
        json!({"limit": limit}),
    )
    .await
}

#[tauri::command]
pub async fn get_mcp_settings(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_mcp_settings", json!({})).await
}

#[tauri::command]
pub async fn set_mcp_settings(
    state: tauri::State<'_, Arc<AppState>>,
    settings: tucano_core::mcp_settings::McpSettings,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "set_mcp_settings",
        json!({"settings": settings}),
    )
    .await
}

#[tauri::command]
pub async fn rotate_mcp_token(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "rotate_mcp_token", json!({})).await
}

#[tauri::command]
pub async fn list_mcp_clients(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "list_mcp_clients", json!({})).await
}

#[tauri::command]
pub async fn mcp_binary_path(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "mcp_binary_path", json!({})).await
}

#[tauri::command]
pub async fn install_mcp_client(
    state: tauri::State<'_, Arc<AppState>>,
    client: String,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "install_mcp_client",
        json!({"client": client}),
    )
    .await
}

#[tauri::command]
pub async fn uninstall_mcp_client(
    state: tauri::State<'_, Arc<AppState>>,
    client: String,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "uninstall_mcp_client",
        json!({"client": client}),
    )
    .await
}

#[tauri::command]
pub async fn get_version(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_version", json!({})).await
}

#[tauri::command]
pub async fn get_stats(state: tauri::State<'_, Arc<AppState>>) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(), "get_stats", json!({})).await
}

#[tauri::command]
pub async fn query_flows(
    state: tauri::State<'_, Arc<AppState>>,
    filter: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    sort: Option<String>,
    descending: Option<bool>,
) -> Result<Value, String> {
    tucano_core::dispatch(state.inner().clone(),"query_flows",json!({"filter": filter, "offset": offset, "limit": limit, "sort": sort, "descending": descending})).await
}

#[tauri::command]
pub async fn export_flows(
    state: tauri::State<'_, Arc<AppState>>,
    format: String,
    ids: Option<Vec<String>>,
) -> Result<Value, String> {
    tucano_core::dispatch(
        state.inner().clone(),
        "export_flows",
        json!({"format": format, "ids": ids}),
    )
    .await
}

#[tauri::command]
pub async fn quit_app(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    tucano_core::cleanup(state.inner()).await?;
    std::process::exit(0);
}
