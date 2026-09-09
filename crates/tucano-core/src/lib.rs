pub mod ca;
pub mod client_proc;
pub mod commands;
pub mod http_client;
pub mod mcp_bridge;
pub mod mcp_install;
pub mod mcp_settings;
pub mod mcp_stdio;
pub mod proxy;
pub mod query;
#[cfg(test)]
mod regression;
pub mod ssl_settings;
pub mod state;
pub mod storage;
pub mod system_proxy;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use state::AppState;
pub use state::{cleanup, CoreEvent};
use std::sync::Arc;

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("invalid {name}: {e}"))
}
fn default_arg<T: DeserializeOwned>(args: &Value, name: &str, default: T) -> Result<T, String> {
    if args.get(name).is_none() {
        Ok(default)
    } else {
        arg(args, name)
    }
}
fn value(v: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Shared command boundary used by desktop IPC, the authenticated HTTP API and CLI.
pub async fn dispatch(state: Arc<AppState>, command: &str, args: Value) -> Result<Value, String> {
    if !args.is_object() && !args.is_null() {
        return Err("command arguments must be an object".into());
    }
    match command {
        "get_version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "get_status" => value(commands::get_status(state)?),
        "start_proxy" => value(commands::start_proxy(state, arg(&args, "port")?).await?),
        "stop_proxy" => value(commands::stop_proxy(state).await?),
        "start_capture" => value(commands::start_capture(state, arg(&args, "port")?).await?),
        "stop_capture" => value(commands::stop_capture(state).await?),
        "install_ca" => value(commands::install_ca(state)?),
        "uninstall_ca" => value(commands::uninstall_ca(state)?),
        "export_ca" => value(commands::export_ca(state)?),
        "toggle_system_proxy" => {
            value(commands::toggle_system_proxy(state, arg(&args, "on")?).await?)
        }
        "get_private_mode" => value(commands::get_private_mode(state)),
        "set_private_mode" => value(commands::set_private_mode(state, arg(&args, "enabled")?)?),
        "clear_flows" => value(commands::clear_flows(state)?),
        "delete_flows" => value(commands::delete_flows(state, arg(&args, "ids")?)?),
        "restore_flows" => value(commands::restore_flows(state, arg(&args, "flows")?)?),
        "list_flows" => value(commands::list_flows(state)?),
        "get_flow" => value(commands::get_flow(state, arg(&args, "id")?)?.ok_or("flow not found")?),
        "query_flows" => value(query::query_flows(
            state,
            serde_json::from_value(if args.is_null() { json!({}) } else { args })
                .map_err(|e| e.to_string())?,
        )?),
        "get_stats" => query::get_stats(state),
        "export_flows" => value(query::export_flows(
            state,
            &arg::<String>(&args, "format")?,
            arg(&args, "ids")?,
        )?),
        "update_flow_note" => value(commands::update_flow_note(
            state,
            arg(&args, "id")?,
            arg(&args, "note")?,
        )?),
        "update_flow_mark" => value(commands::update_flow_mark(
            state,
            arg(&args, "id")?,
            arg(&args, "mark")?,
        )?),
        "replay_flow" => {
            let id: String = arg(&args, "id")?;
            let headers = match arg::<Option<Vec<(String, String)>>>(&args, "headers")? {
                Some(headers) => headers,
                None => {
                    commands::get_flow(state.clone(), id.clone())?
                        .ok_or("flow not found")?
                        .req_headers
                }
            };
            value(commands::replay_flow(state, id, headers, arg(&args, "body")?).await?)
        }
        "compose_request" => value(
            commands::compose_request(
                state,
                arg(&args, "method")?,
                arg(&args, "url")?,
                default_arg(&args, "headers", vec![])?,
                arg(&args, "body")?,
                default_arg(&args, "log", true)?,
            )
            .await?,
        ),
        "save_session" => value(commands::save_session(
            state,
            arg(&args, "path")?,
            arg(&args, "ids")?,
        )?),
        "open_session" => value(commands::open_session(state, arg(&args, "path")?)?),
        "write_text_file" => value(commands::write_text_file(
            arg(&args, "path")?,
            arg(&args, "contents")?,
        )?),
        "write_binary_file" => value(commands::write_binary_file(
            arg(&args, "path")?,
            arg(&args, "contentsBase64")?,
        )?),
        "quit_app" => value(cleanup(&state).await?),
        "get_keep_limit" => value(commands::get_keep_limit(state)),
        "set_keep_limit" => value(commands::set_keep_limit(state, arg(&args, "limit")?)?),
        "get_ssl_settings" => value(commands::get_ssl_settings(state)?),
        "set_ssl_settings" => value(commands::set_ssl_settings(state, arg(&args, "settings")?)?),
        "get_mcp_settings" => value(commands::get_mcp_settings(state)),
        "set_mcp_settings" => {
            value(commands::set_mcp_settings(state, arg(&args, "settings")?).await?)
        }
        "rotate_mcp_token" => value(commands::rotate_mcp_token(state).await?),
        "list_mcp_clients" => value(mcp_install::list_mcp_clients()),
        "mcp_binary_path" => value(mcp_install::mcp_binary_path()?),
        "install_mcp_client" => value(mcp_install::install_mcp_client(
            state,
            arg(&args, "client")?,
        )?),
        "uninstall_mcp_client" => value(mcp_install::uninstall_mcp_client(arg(&args, "client")?)?),
        _ => Err(format!("unknown command: {command}")),
    }
}
