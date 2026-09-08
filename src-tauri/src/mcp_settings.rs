use serde::{Deserialize, Serialize};
use std::path::Path;

/// How the installer wires the `tucano` MCP entry into a client's config.
/// Claude Desktop only ever accepts `Stdio` (its config format has no `url`
/// field); every other client can go either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Http,
    Stdio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    /// Transport the installer uses for clients that support both (all but
    /// Claude Desktop). `#[serde(default)]` so pre-T3 `mcp-settings.json`
    /// files without this field still load.
    #[serde(default)]
    pub transport: McpTransport,
    /// When installing a stdio entry, whether to set
    /// `TUCANO_MCP_AUTOLAUNCH=1` in its env so the bridge launches the app on
    /// first tool call. `#[serde(default)]` for the same reason as above.
    #[serde(default)]
    pub autolaunch: bool,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 7878,
            token: new_token(),
            transport: McpTransport::default(),
            autolaunch: false,
        }
    }
}

pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl McpSettings {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("mcp-settings.json");
        let existed = path.exists();
        let mut s: Self = std::fs::read_to_string(&path).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut dirty = false;
        if s.token.is_empty() { s.token = new_token(); dirty = true; }
        // Persist a freshly generated token on first run so it stays stable
        // across restarts. Otherwise a new token is minted every launch and any
        // client config written by "Install" silently drifts out of sync (401).
        if !existed || dirty {
            let _ = s.save(dir);
        }
        s
    }

    pub fn save(&self, dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = dir.join("mcp-settings.json");
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
