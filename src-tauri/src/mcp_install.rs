use crate::mcp_settings::McpSettings;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use toml_edit::{value, Array, DocumentMut, Item, Table};

const ENTRY_NAME: &str = "tucano";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpClient {
    ClaudeDesktop,
    ClaudeCode,
    Codex,
    OpenCode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub path: String,
    pub installed: bool,
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no home dir".to_string())
}

fn claude_desktop_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(home()?.join("Library/Application Support/Claude/claude_desktop_config.json"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "no APPDATA".to_string())?;
        Ok(appdata.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Ok(home()?.join(".config/Claude/claude_desktop_config.json"))
    }
}

fn claude_code_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".claude.json"))
}

fn codex_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".codex/config.toml"))
}

fn opencode_path() -> Result<PathBuf, String> {
    // OpenCode uses XDG config dir on all platforms.
    Ok(home()?.join(".config/opencode/opencode.json"))
}

fn client_path(c: McpClient) -> Result<PathBuf, String> {
    match c {
        McpClient::ClaudeDesktop => claude_desktop_path(),
        McpClient::ClaudeCode => claude_code_path(),
        McpClient::Codex => codex_path(),
        McpClient::OpenCode => opencode_path(),
    }
}

fn client_meta(c: McpClient) -> (&'static str, &'static str) {
    match c {
        McpClient::ClaudeDesktop => ("claudeDesktop", "Claude Desktop"),
        McpClient::ClaudeCode => ("claudeCode", "Claude Code (terminal)"),
        McpClient::Codex => ("codex", "Codex CLI"),
        McpClient::OpenCode => ("opencode", "OpenCode"),
    }
}

fn read_json(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let s = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if s.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&s).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_json(path: &PathBuf, v: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, s + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_toml(path: &PathBuf) -> Result<DocumentMut, String> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let s = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    s.parse::<DocumentMut>().map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_toml(path: &PathBuf, doc: &DocumentMut) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(path, doc.to_string()).map_err(|e| format!("write {}: {e}", path.display()))
}

fn env_object(settings: &McpSettings) -> serde_json::Map<String, Value> {
    let mut env = serde_json::Map::new();
    env.insert("TUCANO_TOKEN".to_string(), Value::String(settings.token.clone()));
    if settings.port != 7878 {
        env.insert(
            "TUCANO_URL".to_string(),
            Value::String(format!("http://127.0.0.1:{}", settings.port)),
        );
    }
    env
}

fn is_installed(c: McpClient, path: &PathBuf) -> bool {
    if !path.exists() {
        return false;
    }
    match c {
        McpClient::ClaudeDesktop | McpClient::ClaudeCode => {
            let v = read_json(path).unwrap_or(json!({}));
            v.get("mcpServers")
                .and_then(|m| m.get(ENTRY_NAME))
                .is_some()
        }
        McpClient::OpenCode => {
            let v = read_json(path).unwrap_or(json!({}));
            v.get("mcp").and_then(|m| m.get(ENTRY_NAME)).is_some()
        }
        McpClient::Codex => {
            let doc = read_toml(path).unwrap_or_default();
            doc.get("mcp_servers")
                .and_then(|t| t.as_table())
                .map(|t| t.contains_key(ENTRY_NAME))
                .unwrap_or(false)
        }
    }
}

pub fn install(c: McpClient, settings: &McpSettings) -> Result<(), String> {
    let path = client_path(c)?;
    match c {
        McpClient::ClaudeDesktop | McpClient::ClaudeCode => {
            let mut root = read_json(&path)?;
            if !root.is_object() {
                root = json!({});
            }
            let map = root.as_object_mut().unwrap();
            let servers = map
                .entry("mcpServers".to_string())
                .or_insert_with(|| json!({}));
            if !servers.is_object() {
                *servers = json!({});
            }
            servers.as_object_mut().unwrap().insert(
                ENTRY_NAME.to_string(),
                json!({
                    "command": "npx",
                    "args": ["-y", "tucano-mcp"],
                    "env": env_object(settings),
                }),
            );
            write_json(&path, &root)
        }
        McpClient::OpenCode => {
            let mut root = read_json(&path)?;
            if !root.is_object() {
                root = json!({});
            }
            let map = root.as_object_mut().unwrap();
            map.entry("$schema".to_string())
                .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));
            let mcp = map.entry("mcp".to_string()).or_insert_with(|| json!({}));
            if !mcp.is_object() {
                *mcp = json!({});
            }
            mcp.as_object_mut().unwrap().insert(
                ENTRY_NAME.to_string(),
                json!({
                    "type": "local",
                    "command": ["npx", "-y", "tucano-mcp"],
                    "enabled": true,
                    "environment": env_object(settings),
                }),
            );
            write_json(&path, &root)
        }
        McpClient::Codex => {
            let mut doc = read_toml(&path)?;
            if !doc.contains_key("mcp_servers") {
                doc["mcp_servers"] = Item::Table(Table::new());
            }
            let servers = doc["mcp_servers"]
                .as_table_mut()
                .ok_or_else(|| "mcp_servers is not a table".to_string())?;
            servers.set_implicit(true);
            let mut entry = Table::new();
            entry["command"] = value("npx");
            let mut args = Array::new();
            args.push("-y");
            args.push("tucano-mcp");
            entry["args"] = value(args);
            let mut env_tbl = toml_edit::InlineTable::new();
            env_tbl.insert("TUCANO_TOKEN", settings.token.clone().into());
            if settings.port != 7878 {
                env_tbl.insert(
                    "TUCANO_URL",
                    format!("http://127.0.0.1:{}", settings.port).into(),
                );
            }
            entry["env"] = value(env_tbl);
            servers.insert(ENTRY_NAME, Item::Table(entry));
            write_toml(&path, &doc)
        }
    }
}

pub fn uninstall(c: McpClient) -> Result<(), String> {
    let path = client_path(c)?;
    if !path.exists() {
        return Ok(());
    }
    match c {
        McpClient::ClaudeDesktop | McpClient::ClaudeCode => {
            let mut root = read_json(&path)?;
            if let Some(servers) = root
                .as_object_mut()
                .and_then(|m| m.get_mut("mcpServers"))
                .and_then(|v| v.as_object_mut())
            {
                servers.remove(ENTRY_NAME);
            }
            write_json(&path, &root)
        }
        McpClient::OpenCode => {
            let mut root = read_json(&path)?;
            if let Some(mcp) = root
                .as_object_mut()
                .and_then(|m| m.get_mut("mcp"))
                .and_then(|v| v.as_object_mut())
            {
                mcp.remove(ENTRY_NAME);
            }
            write_json(&path, &root)
        }
        McpClient::Codex => {
            let mut doc = read_toml(&path)?;
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(|t| t.as_table_mut()) {
                servers.remove(ENTRY_NAME);
            }
            write_toml(&path, &doc)
        }
    }
}

pub fn status_all() -> Vec<McpClientStatus> {
    [
        McpClient::ClaudeDesktop,
        McpClient::ClaudeCode,
        McpClient::Codex,
        McpClient::OpenCode,
    ]
    .into_iter()
    .map(|c| {
        let (id, label) = client_meta(c);
        let path = client_path(c).unwrap_or_default();
        McpClientStatus {
            id,
            label,
            installed: is_installed(c, &path),
            path: path.to_string_lossy().to_string(),
        }
    })
    .collect()
}

#[tauri::command]
pub fn list_mcp_clients() -> Vec<McpClientStatus> {
    status_all()
}

#[tauri::command]
pub fn install_mcp_client(
    state: tauri::State<'_, Arc<AppState>>,
    client: McpClient,
) -> Result<Vec<McpClientStatus>, String> {
    let settings = state.mcp_settings.lock().clone();
    install(client, &settings)?;
    Ok(status_all())
}

#[tauri::command]
pub fn uninstall_mcp_client(client: McpClient) -> Result<Vec<McpClientStatus>, String> {
    uninstall(client)?;
    Ok(status_all())
}
