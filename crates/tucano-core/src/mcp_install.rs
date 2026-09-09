use crate::mcp_settings::{McpSettings, McpTransport};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use toml_edit::{value, Array, DocumentMut, InlineTable, Item, Table};

const ENTRY_NAME: &str = "tucano";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpClient {
    ClaudeDesktop,
    ClaudeCode,
    Codex,
    CodexDesktop,
    Gemini,
    Pi,
    Antigravity,
    OhMyPi,
    // `rename_all = "camelCase"` would map this to `openCode`, but the frontend
    // (and `client_meta`'s id) use the lowercase `opencode`. Pin it so the
    // round-trip matches and install/uninstall don't fail to deserialize.
    #[serde(rename = "opencode")]
    OpenCode,
    #[serde(rename = "opencodeDesktop")]
    OpenCodeDesktop,
    Grok,
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

/// Resolve `c`'s config path under a given home directory. Split out from
/// `client_path` so tests can point it at a tempdir instead of the real
/// `$HOME` — nothing under test ever touches the caller's actual config.
fn client_path_in(home: &Path, c: McpClient) -> PathBuf {
    match c {
        McpClient::ClaudeDesktop => {
            #[cfg(target_os = "macos")]
            {
                home.join("Library/Application Support/Claude/claude_desktop_config.json")
            }
            #[cfg(target_os = "windows")]
            {
                std::env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join("AppData/Roaming"))
                    .join("Claude")
                    .join("claude_desktop_config.json")
            }
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            {
                home.join(".config/Claude/claude_desktop_config.json")
            }
        }
        McpClient::ClaudeCode => home.join(".claude.json"),
        McpClient::Codex | McpClient::CodexDesktop => home.join(".codex/config.toml"),
        McpClient::Gemini => home.join(".gemini/settings.json"),
        McpClient::Pi => home.join(".pi/agent/extensions/tucano/index.ts"),
        McpClient::Antigravity => {
            let current = home.join(".gemini/config/mcp_config.json");
            let legacy = home.join(".gemini/antigravity/mcp_config.json");
            if !current.exists() && legacy.exists() {
                legacy
            } else {
                current
            }
        }
        McpClient::OhMyPi => home.join(".omp/agent/mcp.json"),
        // OpenCode uses XDG config dir on all platforms.
        McpClient::OpenCode | McpClient::OpenCodeDesktop => {
            home.join(".config/opencode/opencode.json")
        }
        McpClient::Grok => home.join(".grok/config.toml"),
    }
}

fn client_path(c: McpClient) -> Result<PathBuf, String> {
    Ok(client_path_in(&home()?, c))
}

fn client_meta(c: McpClient) -> (&'static str, &'static str) {
    match c {
        McpClient::ClaudeDesktop => ("claudeDesktop", "Claude"),
        McpClient::ClaudeCode => ("claudeCode", "Claude"),
        McpClient::Codex => ("codex", "Codex"),
        McpClient::CodexDesktop => ("codexDesktop", "Codex"),
        McpClient::Gemini => ("gemini", "Gemini"),
        McpClient::Pi => ("pi", "Pi"),
        McpClient::Antigravity => ("antigravity", "Antigravity"),
        McpClient::OhMyPi => ("ohMyPi", "Oh My Pi"),
        McpClient::OpenCode => ("opencode", "OpenCode"),
        McpClient::OpenCodeDesktop => ("opencodeDesktop", "OpenCode"),
        McpClient::Grok => ("grok", "Grok"),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let s = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if s.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&s).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, s + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_toml(path: &Path) -> Result<DocumentMut, String> {
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    let s = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    s.parse::<DocumentMut>()
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_toml(path: &Path, doc: &DocumentMut) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(path, doc.to_string()).map_err(|e| format!("write {}: {e}", path.display()))
}

/// The Tucano MCP endpoint URL for the configured port. Tucano serves the MCP
/// protocol natively over Streamable HTTP at `/mcp`, so clients connect
/// directly — no Node, no npx, no PATH juggling.
fn mcp_url(settings: &McpSettings) -> String {
    format!("http://127.0.0.1:{}/mcp", settings.port)
}

fn bearer(settings: &McpSettings) -> String {
    format!("Bearer {}", settings.token)
}

fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("resolve current exe: {e}"))
}

/// Build the stdio `env` object shared by every client that speaks JSON
/// (Claude Desktop, Claude Code, OpenCode). `TUCANO_MCP_AUTOLAUNCH` is only
/// present at all when `settings.autolaunch` is on — the bridge treats a
/// missing key the same as "0", but an explicit "0" would still read as a
/// stray leftover to anyone inspecting the config by hand.
fn stdio_env_json(settings: &McpSettings, url: &str) -> Value {
    let mut env = serde_json::Map::new();
    env.insert("TUCANO_MCP_URL".to_string(), json!(url));
    env.insert("TUCANO_MCP_TOKEN".to_string(), json!(settings.token));
    if let Some((dir, session)) = settings.launch_context() {
        env.insert("TUCANO_MCP_DATA_DIR".into(), json!(dir));
        env.insert("TUCANO_MCP_SESSION".into(), json!(session));
    }
    if settings.autolaunch {
        env.insert("TUCANO_MCP_AUTOLAUNCH".to_string(), json!("1"));
    }
    Value::Object(env)
}

/// Same as `stdio_env_json` but for the TOML clients (Codex, Grok).
fn stdio_env_toml(settings: &McpSettings, url: &str) -> InlineTable {
    let mut env = InlineTable::new();
    env.insert("TUCANO_MCP_URL", url.into());
    env.insert("TUCANO_MCP_TOKEN", settings.token.as_str().into());
    if let Some((dir, session)) = settings.launch_context() {
        env.insert("TUCANO_MCP_DATA_DIR", dir.into());
        env.insert("TUCANO_MCP_SESSION", session.into());
    }
    if settings.autolaunch {
        env.insert("TUCANO_MCP_AUTOLAUNCH", "1".into());
    }
    env
}

fn is_installed(c: McpClient, path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    match c {
        McpClient::Pi => {
            path.exists()
                && path.with_file_name("tucano-tools.json").exists()
                && path.with_file_name("config.json").exists()
        }
        McpClient::ClaudeDesktop
        | McpClient::ClaudeCode
        | McpClient::Gemini
        | McpClient::Antigravity
        | McpClient::OhMyPi => {
            let v = read_json(path).unwrap_or(json!({}));
            v.get("mcpServers")
                .and_then(|m| m.get(ENTRY_NAME))
                .is_some()
        }
        McpClient::OpenCode | McpClient::OpenCodeDesktop => {
            let v = read_json(path).unwrap_or(json!({}));
            v.get("mcp").and_then(|m| m.get(ENTRY_NAME)).is_some()
        }
        McpClient::Codex | McpClient::CodexDesktop | McpClient::Grok => {
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
    install_at(c, &path, &automatic_settings(c, settings))
}

fn automatic_settings(c: McpClient, settings: &McpSettings) -> McpSettings {
    let mut automatic = settings.clone();
    automatic.transport = if settings.autolaunch || matches!(c, McpClient::ClaudeDesktop) {
        McpTransport::Stdio
    } else {
        McpTransport::Http
    };
    automatic
}

pub fn refresh_installed(settings: &McpSettings) -> Result<(), String> {
    for c in CLIENTS {
        // Desktop/CLI pairs address the same configuration file.
        if matches!(c, McpClient::CodexDesktop | McpClient::OpenCodeDesktop) {
            continue;
        }
        if is_installed(c, &client_path(c)?) {
            install(c, settings).map_err(|e| format!("{}: {e}", client_meta(c).1))?;
        }
    }
    Ok(())
}

fn install_at(c: McpClient, path: &Path, settings: &McpSettings) -> Result<(), String> {
    let url = mcp_url(settings);
    match c {
        McpClient::Pi => {
            let dir = path.parent().ok_or("invalid Pi extension path")?;
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            std::fs::write(path, include_str!("../../../pi-extension/tucano.ts"))
                .map_err(|e| e.to_string())?;
            write_json(
                &dir.join("tucano-tools.json"),
                &crate::mcp_bridge::tools_list(),
            )?;
            write_json(
                &dir.join("config.json"),
                &json!({
                    "url": url, "token": settings.token, "binary": exe_path()?, "autolaunch": settings.autolaunch,
                    "dataDir": settings.launch_context().map(|c| c.0), "session": settings.launch_context().map(|c| c.1)
                }),
            )
        }
        McpClient::Antigravity => {
            let entry = match settings.transport {
                McpTransport::Http => json!({
                    "serverUrl": url,
                    "headers": { "Authorization": bearer(settings) },
                }),
                McpTransport::Stdio => json!({
                    "command": exe_path()?,
                    "args": ["mcp-stdio"],
                    "env": stdio_env_json(settings, &url),
                }),
            };
            install_json(path, "mcpServers", entry)
        }
        McpClient::Gemini => {
            let entry = match settings.transport {
                McpTransport::Http => json!({
                    "httpUrl": url,
                    "headers": { "Authorization": bearer(settings) },
                }),
                McpTransport::Stdio => json!({
                    "command": exe_path()?,
                    "args": ["mcp-stdio"],
                    "env": stdio_env_json(settings, &url),
                }),
            };
            install_json(path, "mcpServers", entry)
        }
        McpClient::ClaudeCode | McpClient::OhMyPi => {
            let entry = match settings.transport {
                McpTransport::Http => json!({
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": bearer(settings) },
                }),
                McpTransport::Stdio => json!({
                    "type": "stdio",
                    "command": exe_path()?,
                    "args": ["mcp-stdio"],
                    "env": stdio_env_json(settings, &url),
                }),
            };
            install_json(path, "mcpServers", entry)
        }
        McpClient::ClaudeDesktop => {
            // Claude Desktop's config file ONLY accepts stdio servers
            // (`command` + `args`); a `type: http` / `url` entry is rejected as
            // invalid and silently dropped. Rather than depend on Node/npx
            // (`mcp-remote`), we point it at Tucano's own binary running in
            // `mcp-stdio` mode, which bridges to the native HTTP /mcp endpoint.
            let entry = json!({
                "command": exe_path()?,
                "args": ["mcp-stdio"],
                "env": stdio_env_json(settings, &url),
            });
            install_json(path, "mcpServers", entry)
        }
        McpClient::OpenCode | McpClient::OpenCodeDesktop => {
            let entry = match settings.transport {
                McpTransport::Http => json!({
                    "type": "remote",
                    "url": url,
                    "enabled": true,
                    "headers": { "Authorization": bearer(settings) },
                }),
                McpTransport::Stdio => json!({
                    "type": "local",
                    "command": [exe_path()?, "mcp-stdio"],
                    "environment": stdio_env_json(settings, &url),
                    "enabled": true,
                }),
            };
            let mut root = read_json(path)?;
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
            mcp.as_object_mut()
                .unwrap()
                .insert(ENTRY_NAME.to_string(), entry);
            write_json(path, &root)
        }
        McpClient::Codex | McpClient::CodexDesktop => {
            let entry = match settings.transport {
                McpTransport::Http => {
                    let mut entry = Table::new();
                    entry["url"] = value(url.as_str());
                    entry["enabled"] = value(true);
                    let mut headers = InlineTable::new();
                    headers.insert("Authorization", bearer(settings).into());
                    entry["http_headers"] = value(headers);
                    entry
                }
                McpTransport::Stdio => {
                    let mut entry = Table::new();
                    entry["command"] = value(exe_path()?.as_str());
                    let mut args = Array::new();
                    args.push("mcp-stdio");
                    entry["args"] = value(args);
                    entry["env"] = value(stdio_env_toml(settings, &url));
                    entry
                }
            };
            install_toml(path, entry)
        }
        McpClient::Grok => {
            let entry = match settings.transport {
                McpTransport::Http => {
                    let mut entry = Table::new();
                    entry["url"] = value(url.as_str());
                    entry["enabled"] = value(true);
                    // NB: Grok's key is `headers`, not `http_headers` as in
                    // Codex's config.toml — verified in mcp-clientes note.
                    let mut headers = Table::new();
                    headers.set_implicit(false);
                    headers["Authorization"] = value(bearer(settings).as_str());
                    entry["headers"] = Item::Table(headers);
                    entry
                }
                McpTransport::Stdio => {
                    let mut entry = Table::new();
                    entry["command"] = value(exe_path()?.as_str());
                    let mut args = Array::new();
                    args.push("mcp-stdio");
                    entry["args"] = value(args);
                    entry["env"] = value(stdio_env_toml(settings, &url));
                    entry
                }
            };
            install_toml(path, entry)
        }
    }
}

/// Insert `entry` as `root[key][ENTRY_NAME]`, replacing whatever was there —
/// including any leftover fields from a previous install under the other
/// transport. `root[key]` and its siblings (other servers, other top-level
/// keys) are preserved as-is.
fn install_json(path: &Path, key: &str, entry: Value) -> Result<(), String> {
    let mut root = read_json(path)?;
    if !root.is_object() {
        root = json!({});
    }
    let map = root.as_object_mut().unwrap();
    let servers = map.entry(key.to_string()).or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(ENTRY_NAME.to_string(), entry);
    write_json(path, &root)
}

/// Same as `install_json` but for the `[mcp_servers.tucano]` TOML clients
/// (Codex, Grok). Inserting a fresh `Table` at the key fully replaces any
/// previous entry — no leftover `url`/`http_headers`/`headers` when switching
/// to stdio, no leftover `command`/`args`/`env` when switching to http.
/// Pre-existing content elsewhere in the document (other servers, comments)
/// is untouched.
fn install_toml(path: &Path, entry: Table) -> Result<(), String> {
    let mut doc = read_toml(path)?;
    if !doc.contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| "mcp_servers is not a table".to_string())?;
    servers.set_implicit(true);
    servers.insert(ENTRY_NAME, Item::Table(entry));
    write_toml(path, &doc)
}

pub fn uninstall(c: McpClient) -> Result<(), String> {
    let path = client_path(c)?;
    uninstall_at(c, &path)
}

fn uninstall_at(c: McpClient, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match c {
        McpClient::Pi => {
            // Remove only the three files owned by this installer.
            for name in ["index.ts", "tucano-tools.json", "config.json"] {
                let file = path.with_file_name(name);
                if file.exists() {
                    std::fs::remove_file(file).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        McpClient::ClaudeDesktop
        | McpClient::ClaudeCode
        | McpClient::Gemini
        | McpClient::Antigravity
        | McpClient::OhMyPi => {
            let mut root = read_json(path)?;
            if let Some(servers) = root
                .as_object_mut()
                .and_then(|m| m.get_mut("mcpServers"))
                .and_then(|v| v.as_object_mut())
            {
                servers.remove(ENTRY_NAME);
            }
            write_json(path, &root)
        }
        McpClient::OpenCode | McpClient::OpenCodeDesktop => {
            let mut root = read_json(path)?;
            if let Some(mcp) = root
                .as_object_mut()
                .and_then(|m| m.get_mut("mcp"))
                .and_then(|v| v.as_object_mut())
            {
                mcp.remove(ENTRY_NAME);
            }
            write_json(path, &root)
        }
        McpClient::Codex | McpClient::CodexDesktop | McpClient::Grok => {
            let mut doc = read_toml(path)?;
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(|t| t.as_table_mut()) {
                servers.remove(ENTRY_NAME);
            }
            write_toml(path, &doc)
        }
    }
}

const CLIENTS: [McpClient; 11] = [
    McpClient::ClaudeDesktop,
    McpClient::ClaudeCode,
    McpClient::CodexDesktop,
    McpClient::Codex,
    McpClient::OpenCodeDesktop,
    McpClient::OpenCode,
    McpClient::Grok,
    McpClient::Gemini,
    McpClient::Pi,
    McpClient::Antigravity,
    McpClient::OhMyPi,
];

pub fn status_all() -> Vec<McpClientStatus> {
    CLIENTS
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

pub fn list_mcp_clients() -> Vec<McpClientStatus> {
    status_all()
}

/// Absolute path to Tucano's own executable — the `command` a stdio MCP client
/// (e.g. Claude Desktop) spawns as `<exe> mcp-stdio`. Surfaced to the UI so the
/// manual-config snippet shows the real path.
pub fn mcp_binary_path() -> Result<String, String> {
    exe_path()
}

pub fn install_mcp_client(
    state: Arc<AppState>,
    client: McpClient,
) -> Result<Vec<McpClientStatus>, String> {
    let settings = state.mcp_settings.lock().clone();
    install(client, &settings)?;
    Ok(status_all())
}

pub fn uninstall_mcp_client(client: McpClient) -> Result<Vec<McpClientStatus>, String> {
    uninstall(client)?;
    Ok(status_all())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_settings::McpSettings;

    fn settings(transport: McpTransport, autolaunch: bool) -> McpSettings {
        McpSettings {
            enabled: true,
            port: 7878,
            token: "test-token".to_string(),
            transport,
            autolaunch,
            runtime_data_dir: None,
        }
    }

    #[test]
    fn new_clients_preserve_other_settings_across_transport_changes_and_removal() {
        for (c, url_key) in [
            (McpClient::Antigravity, "serverUrl"),
            (McpClient::OhMyPi, "url"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = client_path_in(dir.path(), c);
            write_json(&path, &json!({"preferences": {"keep": true}, "mcpServers": {"other": {"command": "keep"}}})).unwrap();
            install_at(
                c,
                &path,
                &automatic_settings(c, &settings(McpTransport::Http, false)),
            )
            .unwrap();
            assert!(is_installed(c, &path));
            let root = read_json(&path).unwrap();
            let entry = &root["mcpServers"]["tucano"];
            assert_eq!(entry[url_key], "http://127.0.0.1:7878/mcp");
            assert_eq!(entry["headers"]["Authorization"], "Bearer test-token");
            if matches!(c, McpClient::OhMyPi) {
                assert_eq!(entry["type"], "http");
            }
            install_at(
                c,
                &path,
                &automatic_settings(c, &settings(McpTransport::Http, true)),
            )
            .unwrap();
            let root = read_json(&path).unwrap();
            let entry = &root["mcpServers"]["tucano"];
            assert!(entry.get(url_key).is_none());
            assert!(entry.get("headers").is_none());
            assert_eq!(entry["args"], json!(["mcp-stdio"]));
            assert_eq!(entry["env"]["TUCANO_MCP_AUTOLAUNCH"], "1");
            install_at(
                c,
                &path,
                &automatic_settings(c, &settings(McpTransport::Http, false)),
            )
            .unwrap();
            let root = read_json(&path).unwrap();
            assert!(root["mcpServers"]["tucano"].get("command").is_none());
            assert!(root["mcpServers"]["tucano"].get("env").is_none());
            uninstall_at(c, &path).unwrap();
            assert!(!is_installed(c, &path));
            let root = read_json(&path).unwrap();
            assert_eq!(root["preferences"]["keep"], true);
            assert_eq!(root["mcpServers"]["other"]["command"], "keep");
        }
    }

    #[test]
    fn antigravity_prefers_current_path_with_legacy_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join(".gemini/config/mcp_config.json");
        let legacy = dir.path().join(".gemini/antigravity/mcp_config.json");
        assert_eq!(client_path_in(dir.path(), McpClient::Antigravity), current);
        write_json(&legacy, &json!({})).unwrap();
        assert_eq!(client_path_in(dir.path(), McpClient::Antigravity), legacy);
        write_json(&current, &json!({})).unwrap();
        assert_eq!(client_path_in(dir.path(), McpClient::Antigravity), current);
    }

    #[test]
    fn automatic_connection_respects_client_and_autolaunch() {
        for c in CLIENTS {
            let manual = automatic_settings(c, &settings(McpTransport::Stdio, false));
            assert_eq!(
                manual.transport,
                if matches!(c, McpClient::ClaudeDesktop) {
                    McpTransport::Stdio
                } else {
                    McpTransport::Http
                }
            );
            let auto = automatic_settings(c, &settings(McpTransport::Http, true));
            assert_eq!(auto.transport, McpTransport::Stdio);
            assert!(auto.autolaunch);
        }
    }

    #[test]
    fn pi_install_refresh_and_remove_preserve_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Pi);
        install_at(McpClient::Pi, &path, &settings(McpTransport::Http, false)).unwrap();
        assert!(is_installed(McpClient::Pi, &path));
        let extra = path.with_file_name("personal.txt");
        std::fs::write(&extra, "keep").unwrap();
        install_at(McpClient::Pi, &path, &settings(McpTransport::Stdio, true)).unwrap();
        let config = read_json(&path.with_file_name("config.json")).unwrap();
        assert_eq!(config["autolaunch"], true);
        assert!(config["binary"].as_str().is_some());
        let catalog = read_json(&path.with_file_name("tucano-tools.json")).unwrap();
        assert!(!catalog.as_array().unwrap().is_empty());
        uninstall_at(McpClient::Pi, &path).unwrap();
        assert!(!is_installed(McpClient::Pi, &path));
        assert!(!path.with_file_name("config.json").exists());
        assert_eq!(std::fs::read_to_string(extra).unwrap(), "keep");
    }

    #[test]
    fn gemini_transport_swap_preserves_other_settings_and_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Gemini);
        write_json(
            &path,
            &json!({"theme": "custom", "mcpServers": {"other": {"command": "other"}}}),
        )
        .unwrap();
        install_at(
            McpClient::Gemini,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        let root = read_json(&path).unwrap();
        assert_eq!(
            root["mcpServers"]["tucano"]["httpUrl"],
            "http://127.0.0.1:7878/mcp"
        );
        assert_eq!(
            root["mcpServers"]["tucano"]["headers"]["Authorization"],
            "Bearer test-token"
        );
        install_at(
            McpClient::Gemini,
            &path,
            &settings(McpTransport::Stdio, true),
        )
        .unwrap();
        let root = read_json(&path).unwrap();
        assert!(root["mcpServers"]["tucano"].get("httpUrl").is_none());
        assert_eq!(
            root["mcpServers"]["tucano"]["env"]["TUCANO_MCP_AUTOLAUNCH"],
            "1"
        );
        assert!(is_installed(McpClient::Gemini, &path));
        uninstall_at(McpClient::Gemini, &path).unwrap();
        assert!(!is_installed(McpClient::Gemini, &path));
        let root = read_json(&path).unwrap();
        assert_eq!(root["theme"], "custom");
        assert_eq!(root["mcpServers"]["other"]["command"], "other");
    }

    #[test]
    fn codex_desktop_and_cli_share_installation() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = client_path_in(dir.path(), McpClient::CodexDesktop);
        let cli = client_path_in(dir.path(), McpClient::Codex);
        assert_eq!(desktop, cli);
        assert_ne!(
            client_meta(McpClient::CodexDesktop).0,
            client_meta(McpClient::Codex).0
        );
        install_at(
            McpClient::CodexDesktop,
            &desktop,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        assert!(is_installed(McpClient::Codex, &cli));
        uninstall_at(McpClient::Codex, &cli).unwrap();
        assert!(!is_installed(McpClient::CodexDesktop, &desktop));
    }

    #[test]
    fn grok_install_uninstall_http() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Grok);
        assert!(!is_installed(McpClient::Grok, &path));

        install_at(McpClient::Grok, &path, &settings(McpTransport::Http, false)).unwrap();
        assert!(is_installed(McpClient::Grok, &path));

        let doc = read_toml(&path).unwrap();
        let entry = doc["mcp_servers"]["tucano"].as_table().unwrap();
        assert_eq!(entry["url"].as_str().unwrap(), "http://127.0.0.1:7878/mcp");
        assert!(entry["enabled"].as_bool().unwrap());
        assert_eq!(
            entry["headers"]["Authorization"].as_str().unwrap(),
            "Bearer test-token"
        );
        assert!(
            entry.get("http_headers").is_none(),
            "Grok key must be `headers`, not `http_headers`"
        );
        assert!(entry.get("command").is_none());

        uninstall_at(McpClient::Grok, &path).unwrap();
        assert!(!is_installed(McpClient::Grok, &path));
    }

    #[test]
    fn grok_install_uninstall_stdio() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Grok);

        install_at(McpClient::Grok, &path, &settings(McpTransport::Stdio, true)).unwrap();
        assert!(is_installed(McpClient::Grok, &path));

        let doc = read_toml(&path).unwrap();
        let entry = doc["mcp_servers"]["tucano"].as_table().unwrap();
        assert!(entry.get("command").is_some());
        assert_eq!(
            entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["mcp-stdio"]
        );
        let env = entry["env"].as_inline_table().unwrap();
        assert_eq!(
            env.get("TUCANO_MCP_URL").unwrap().as_str().unwrap(),
            "http://127.0.0.1:7878/mcp"
        );
        assert_eq!(
            env.get("TUCANO_MCP_TOKEN").unwrap().as_str().unwrap(),
            "test-token"
        );
        assert_eq!(
            env.get("TUCANO_MCP_AUTOLAUNCH").unwrap().as_str().unwrap(),
            "1"
        );
        assert!(entry.get("url").is_none());

        uninstall_at(McpClient::Grok, &path).unwrap();
        assert!(!is_installed(McpClient::Grok, &path));
    }

    #[test]
    fn grok_stdio_without_autolaunch_omits_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Grok);
        install_at(
            McpClient::Grok,
            &path,
            &settings(McpTransport::Stdio, false),
        )
        .unwrap();
        let doc = read_toml(&path).unwrap();
        let env = doc["mcp_servers"]["tucano"]["env"]
            .as_inline_table()
            .unwrap();
        assert!(env.get("TUCANO_MCP_AUTOLAUNCH").is_none());
    }

    #[test]
    fn codex_transport_swap_http_stdio_http_leaves_no_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Codex);

        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Stdio, false),
        )
        .unwrap();
        {
            let doc = read_toml(&path).unwrap();
            let entry = doc["mcp_servers"]["tucano"].as_table().unwrap();
            assert!(
                entry.get("url").is_none(),
                "url must not survive switching to stdio"
            );
            assert!(
                entry.get("http_headers").is_none(),
                "http_headers must not survive switching to stdio"
            );
            assert!(entry.get("command").is_some());
        }

        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        {
            let doc = read_toml(&path).unwrap();
            let entry = doc["mcp_servers"]["tucano"].as_table().unwrap();
            assert!(
                entry.get("command").is_none(),
                "command must not survive switching back to http"
            );
            assert!(entry.get("args").is_none());
            assert!(entry.get("env").is_none());
            assert_eq!(entry["url"].as_str().unwrap(), "http://127.0.0.1:7878/mcp");
        }
    }

    #[test]
    fn preserves_preexisting_server_and_comment() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Codex);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "# personal notes, do not remove\n[mcp_servers.outro]\nurl = \"http://example.com/mcp\"\nenabled = true\n",
        )
        .unwrap();

        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("# personal notes, do not remove"));
        let doc = read_toml(&path).unwrap();
        assert_eq!(
            doc["mcp_servers"]["outro"]["url"].as_str().unwrap(),
            "http://example.com/mcp"
        );
        assert!(doc["mcp_servers"]["tucano"]["url"].as_str().is_some());
    }

    #[test]
    fn is_installed_detects_both_json_formats() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::ClaudeCode);
        install_at(
            McpClient::ClaudeCode,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        assert!(is_installed(McpClient::ClaudeCode, &path));
        install_at(
            McpClient::ClaudeCode,
            &path,
            &settings(McpTransport::Stdio, false),
        )
        .unwrap();
        assert!(is_installed(McpClient::ClaudeCode, &path));
    }

    #[test]
    fn is_installed_detects_both_toml_formats() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Codex);
        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Http, false),
        )
        .unwrap();
        assert!(is_installed(McpClient::Codex, &path));
        install_at(
            McpClient::Codex,
            &path,
            &settings(McpTransport::Stdio, false),
        )
        .unwrap();
        assert!(is_installed(McpClient::Codex, &path));
    }

    #[test]
    fn old_settings_file_without_new_fields_loads_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("mcp-settings.json"),
            r#"{"enabled":true,"port":7878,"token":"abc"}"#,
        )
        .unwrap();
        let s = McpSettings::load(dir.path()).unwrap();
        assert!(s.enabled);
        assert_eq!(s.port, 7878);
        assert_eq!(s.token, "abc");
        assert_eq!(s.transport, McpTransport::Http);
        assert!(!s.autolaunch);
    }

    #[test]
    fn prints_grok_config_toml_http_and_stdio() {
        let dir = tempfile::tempdir().unwrap();
        let path = client_path_in(dir.path(), McpClient::Grok);

        install_at(McpClient::Grok, &path, &settings(McpTransport::Http, false)).unwrap();
        println!(
            "--- Grok config.toml (http) ---\n{}",
            std::fs::read_to_string(&path).unwrap()
        );

        install_at(McpClient::Grok, &path, &settings(McpTransport::Stdio, true)).unwrap();
        println!(
            "--- Grok config.toml (stdio) ---\n{}",
            std::fs::read_to_string(&path).unwrap()
        );
    }
}
