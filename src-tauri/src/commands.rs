use crate::ssl_settings::SslSettings;
use crate::state::AppState;
use crate::storage::Flow;
use crate::{proxy, system_proxy};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

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
    let active_port = state.port.load(Ordering::SeqCst);
    if let Err(e) = system_proxy::set(true, active_port) {
        tracing::error!("system_proxy set failed: {e}");
        return Err(format!("system proxy: {e}"));
    }
    state.system_proxy_on.store(true, Ordering::SeqCst);
    Ok(())
}

/// Atomic "Stop capturing": tears down the OS proxy first (so the user's
/// internet is restored immediately) and then stops the local server.
#[tauri::command]
pub fn stop_capture(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let port = state.port.load(Ordering::SeqCst);
    if state.system_proxy_on.load(Ordering::SeqCst) {
        let _ = system_proxy::set(false, port);
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
pub fn list_flows(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Flow>, String> {
    state.storage.lock().list().map_err(err)
}

#[tauri::command]
pub fn get_flow(state: tauri::State<'_, Arc<AppState>>, id: String) -> Result<Option<Flow>, String> {
    state.storage.lock().get(&id).map_err(err)
}

#[tauri::command]
pub fn replay_flow(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<String, String> {
    let _ = (state, id, headers, body);
    // v0.2 — TODO: send replay through internal client and create new flow.
    Err("replay not yet implemented".into())
}

#[tauri::command]
pub fn save_session(state: tauri::State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    state.storage.lock().save_to(&PathBuf::from(path)).map_err(err)
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
