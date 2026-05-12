use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self { enabled: false, port: 7878, token: new_token() }
    }
}

pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl McpSettings {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("mcp-settings.json");
        let mut s: Self = std::fs::read_to_string(&path).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if s.token.is_empty() { s.token = new_token(); }
        s
    }

    pub fn save(&self, dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = dir.join("mcp-settings.json");
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}
