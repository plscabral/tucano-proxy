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
    /// Runtime context used by generated client launchers; never client-controlled JSON.
    #[serde(skip)]
    pub runtime_data_dir: Option<std::path::PathBuf>,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 7878,
            token: new_token(),
            transport: McpTransport::default(),
            autolaunch: false,
            runtime_data_dir: None,
        }
    }
}

pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl McpSettings {
    pub fn load(dir: &Path) -> crate::state::BoxResult<Self> {
        let path = dir.join("mcp-settings.json");
        let (mut s, mut dirty) = match std::fs::read_to_string(&path) {
            Ok(text) => (serde_json::from_str::<Self>(&text)?, false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Self::default(), true),
            Err(e) => return Err(e.into()),
        };
        if s.token.is_empty() {
            s.token = new_token();
            dirty = true;
        }
        s.runtime_data_dir = Some(dir.to_path_buf());
        if dirty {
            s.save(dir)?;
        }
        Ok(s)
    }

    pub fn save(&self, dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = dir.join("mcp-settings.json");
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        temp.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
    pub fn launch_context(&self) -> Option<(String, String)> {
        let dir = self.runtime_data_dir.as_ref()?;
        let sessions = dir.parent()?;
        if sessions.file_name()? != "sessions" {
            return None;
        }
        Some((
            sessions.parent()?.to_string_lossy().into_owned(),
            dir.file_name()?.to_string_lossy().into_owned(),
        ))
    }
}
