mod ca;
mod client_proc;
mod commands;
mod proxy;
mod ssl_settings;
mod state;
mod storage;
mod system_proxy;

use state::AppState;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tucano_lib=info,hudsucker=warn".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = Arc::new(AppState::new(handle.clone()).expect("init state"));
            app.manage(state.clone());

            // Trap SIGINT / SIGTERM (Ctrl+C in `tauri dev`, terminal close, etc).
            // Reverts the OS proxy synchronously before the process dies.
            let st_for_signal = state.clone();
            let h_for_signal = handle.clone();
            let _ = ctrlc::set_handler(move || {
                cleanup_state(&st_for_signal);
                let _ = h_for_signal.exit(0);
                // If the runtime didn't honor exit fast enough, force.
                std::process::exit(0);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                eprintln!("[tucano] window close requested — running cleanup");
                let app = window.app_handle().clone();
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    cleanup_state(&state);
                }
                // Force the whole app to quit (on macOS, closing the window
                // alone leaves the process alive in the background).
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::install_ca,
            commands::export_ca,
            commands::toggle_system_proxy,
            commands::clear_flows,
            commands::delete_flows,
            commands::list_flows,
            commands::get_flow,
            commands::replay_flow,
            commands::save_session,
            commands::open_session,
            commands::get_ssl_settings,
            commands::set_ssl_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error building Tucano");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                cleanup_state(&state);
            }
        }
    });
}

fn cleanup_state(state: &Arc<AppState>) {
    eprintln!(
        "[tucano] cleanup: running={} system_proxy_on={}",
        state.running.load(Ordering::SeqCst),
        state.system_proxy_on.load(Ordering::SeqCst),
    );
    // ALWAYS try to disable the OS proxy on shutdown, even if our internal
    // flag desynced — leaves the user with working internet.
    let port = state.port.load(Ordering::SeqCst);
    let _ = system_proxy::set(false, port);
    state.system_proxy_on.store(false, Ordering::SeqCst);
    if let Some(tx) = state.stop_tx.lock().take() { let _ = tx.send(()); }
    state.running.store(false, Ordering::SeqCst);
    eprintln!("[tucano] cleanup done");
}
