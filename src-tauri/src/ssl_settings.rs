use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslSettings {
    /// "all" — decrypt every HTTPS host (default)
    /// "allowlist" — only decrypt hosts matching `hosts`
    /// "blocklist" — decrypt every host except those matching `hosts`
    pub mode: String,
    pub hosts: Vec<String>,
    /// Hosts that are always tunneled (never MITM-intercepted), independent of
    /// `mode`. Appended at runtime to the hardcoded PINNED_HOSTS list.
    #[serde(default)]
    pub skip_hosts: Vec<String>,
}

impl Default for SslSettings {
    fn default() -> Self { Self { mode: "all".into(), hosts: vec![], skip_hosts: vec![] } }
}

impl SslSettings {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("ssl-settings.json");
        std::fs::read_to_string(path).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = dir.join("ssl-settings.json");
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Return true when the host's body should be captured.
    pub fn should_capture(&self, host: &str) -> bool {
        match self.mode.as_str() {
            "allowlist" => self.hosts.iter().any(|p| matches_host(p, host)),
            "blocklist" => !self.hosts.iter().any(|p| matches_host(p, host)),
            _ => true,
        }
    }

    /// Whether to MITM-intercept this host at all (vs. tunnel raw bytes).
    /// Hosts that need client-certificate authentication (smart cards,
    /// PJe judicial system, banks) MUST be tunneled — interception breaks
    /// the client-cert handshake.
    /// Known certificate-pinned hosts are always bypassed to prevent
    /// `tls handshake eof` errors and broken functionality (e.g. WhatsApp media).
    pub fn should_intercept(&self, host: &str) -> bool {
        if PINNED_HOSTS.iter().any(|p| matches_host(p, host)) {
            return false;
        }
        if self.skip_hosts.iter().any(|p| matches_host(p, host)) {
            return false;
        }
        self.should_capture(host)
    }

}

/// Hosts known to use certificate pinning. Intercepting them causes a TLS
/// handshake EOF (the app rejects the proxy's cert) and breaks functionality
/// like WhatsApp media downloads. These are always tunneled regardless of the
/// user's SSL mode setting.
const PINNED_HOSTS: &[&str] = &[
    // WhatsApp / Meta
    "*.whatsapp.net",
    "*.whatsapp.com",
    "*.fbcdn.net",
    "*.facebook.com",
    "*.instagram.com",
    // Apple push / iCloud
    "*.apple.com",
    "*.icloud.com",
    "*.push.apple.com",
    // Google
    "*.googleapis.com",
    "*.google.com",
    "*.gstatic.com",
    // OpenAI / ChatGPT
    "*.openai.com",
    "*.chatgpt.com",
    "*.oaiusercontent.com",
    "*.oaidynamic.com",
    // Anthropic / Claude — Node/Electron clients use their own CA bundle and
    // reject the Tucano cert, which breaks Claude Desktop's API traffic (and the
    // MCP integration Tucano itself ships). Always tunnel.
    "*.anthropic.com",
    "*.claude.ai",
    "*.claude.com",
    // Misc known-pinned
    "*.twitter.com",
    "*.x.com",
    "*.twimg.com",
];

/// Glob-ish host match: supports `*.foo.com`, `api.*`, exact match, case-insensitive.
fn matches_host(pattern: &str, host: &str) -> bool {
    let p = pattern.trim().to_lowercase();
    let h = host.to_lowercase();
    if p.is_empty() { return false; }
    if p == h { return true; }
    if let Some(suffix) = p.strip_prefix("*.") {
        return h == suffix || h.ends_with(&format!(".{suffix}"));
    }
    if let Some(prefix) = p.strip_suffix(".*") {
        return h == prefix || h.starts_with(&format!("{prefix}."));
    }
    if p.contains('*') {
        // simple "a*b" pattern
        let parts: Vec<&str> = p.split('*').collect();
        if parts.len() == 2 {
            return h.starts_with(parts[0]) && h.ends_with(parts[1]);
        }
    }
    false
}
