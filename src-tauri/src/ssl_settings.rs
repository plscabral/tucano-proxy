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
    /// Client applications whose traffic is always tunneled (never intercepted),
    /// matched case-insensitively as a substring of the resolved app name /
    /// command line. Use for apps that ship their own truststore and reject the
    /// proxy's MITM cert — they break under interception no matter what (e.g.
    /// PJe Office). A built-in base list (ALWAYS_BYPASS_APPS) is always applied
    /// on top.
    #[serde(default)]
    pub skip_apps: Vec<String>,
}

impl Default for SslSettings {
    fn default() -> Self { Self { mode: "all".into(), hosts: vec![], skip_hosts: vec![], skip_apps: vec![] } }
}

/// Built-in client apps whose traffic is always tunneled. PJe Office is a Java
/// app with its own bundled truststore: it rejects the proxy's MITM certificate
/// (the system CA is invisible to it), so intercepting it breaks its court
/// submissions ("Não foi possível enviar os dados ao servidor"). Tunneling it
/// keeps it working — its own calls stay opaque, but the browser's PJe traffic
/// is still captured normally. Matched as a lowercase substring, so this covers
/// "PJeOffice-Pro", "PjeOffice", etc.
const ALWAYS_BYPASS_APPS: &[&str] = &["pjeoffice"];

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

    /// Whether this client app's traffic should bypass interception (tunnel
    /// raw). Matches the built-in base list and the user's `skip_apps` as
    /// case-insensitive substrings of the resolved app name / command line.
    pub fn should_skip_app(&self, app: &str) -> bool {
        let a = app.to_lowercase();
        if a.is_empty() { return false; }
        ALWAYS_BYPASS_APPS.iter().any(|p| a.contains(*p))
            || self.skip_apps.iter().any(|p| {
                let p = p.trim().to_lowercase();
                !p.is_empty() && a.contains(&p)
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> SslSettings {
        SslSettings { mode: "all".into(), hosts: vec![], skip_hosts: vec![], skip_apps: vec![] }
    }

    #[test]
    fn pjeoffice_app_is_bypassed_by_default() {
        let s = settings();
        // Resolved bundle name is "PJeOffice-Pro" → matched by built-in "pjeoffice".
        assert!(s.should_skip_app("PJeOffice-Pro"));
        assert!(s.should_skip_app("java -jar /Applications/pjeoffice-pro.app/.../pjeoffice-pro.jar"));
        // Unrelated apps are not.
        assert!(!s.should_skip_app("Google Chrome"));
        assert!(!s.should_skip_app(""));
    }

    #[test]
    fn user_skip_apps_match_substring() {
        let mut s = settings();
        s.skip_apps = vec!["MyBank".into()];
        assert!(s.should_skip_app("MyBank Desktop"));
        assert!(!s.should_skip_app("Safari"));
    }
}
