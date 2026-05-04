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
use tauri::menu::{MenuBuilder, SubmenuBuilder, PredefinedMenuItem};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // hudsucker::proxy::internal spams ERROR "tls handshake eof" for every
    // app with certificate pinning (WhatsApp, banking apps, etc.) — these
    // are expected and not actionable. Silence that module while keeping
    // warnings from the rest of hudsucker.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| {
                    "tucano_lib=info,hudsucker=warn,hudsucker::proxy::internal=off".into()
                }),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = Arc::new(AppState::new(handle.clone()).expect("init state"));
            app.manage(state.clone());

            // Replace the default macOS menu so Cmd+F isn't swallowed by a
            // built-in "Find" item — we route Cmd+F to the in-app body
            // search inside CodeMirror / preview iframes.
            #[cfg(target_os = "macos")]
            {
                let app_submenu = SubmenuBuilder::new(app, "Tucano Proxy")
                    .item(&PredefinedMenuItem::about(app, None, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, None)?)
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, None)?)
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .item(&window_submenu)
                    .build()?;
                app.set_menu(menu)?;
            }

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
                // NOTE: we don't `app.exit(0)` here — that would race the JS
                // close handler and bypass the user's "are you sure?" prompt.
                // The frontend calls the `quit_app` command after confirming.
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::start_capture,
            commands::stop_capture,
            commands::install_ca,
            commands::uninstall_ca,
            commands::export_ca,
            commands::toggle_system_proxy,
            commands::clear_flows,
            commands::delete_flows,
            commands::restore_flows,
            commands::list_flows,
            commands::get_flow,
            commands::update_flow_note,
            commands::replay_flow,
            commands::save_session,
            commands::open_session,
            commands::write_text_file,
            commands::write_binary_file,
            commands::quit_app,
            commands::get_ssl_settings,
            commands::set_ssl_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error building Tucano");

    app.run(|app_handle, event| {
        match event {
            // Hard exit (process is shutting down). Run final cleanup.
            tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    cleanup_state(&state);
                }
            }
            // Soft exit request (Cmd+Q, dock quit, etc). The frontend is the
            // source of truth: it shows the "Quit Tucano?" confirm dialog and
            // explicitly calls the `quit_app` command (which uses
            // `app_handle.exit(0)` and bypasses this event). Anything reaching
            // here is a system termination we should hold so the user has a
            // chance to cancel — otherwise hitting Cancel still ends up
            // closing because the app-level exit kept rolling.
            tauri::RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            _ => {}
        }
    });
}

pub fn cleanup_state(state: &Arc<AppState>) {
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
