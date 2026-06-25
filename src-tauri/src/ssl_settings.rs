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
    /// Hosts the user chose to always tunnel (never MITM-intercepted),
    /// independent of `mode`. Empty by default — Tucano captures everything,
    /// like Fiddler. The adaptive auto-bypass appends a host here only if its
    /// TLS handshake actually fails (genuine cert-pinning / mutual-TLS).
    #[serde(default)]
    pub skip_hosts: Vec<String>,
    /// Client applications whose traffic is always tunneled (never intercepted),
    /// matched case-insensitively as a substring of the resolved app name. Use
    /// for apps that ship their own truststore and reject the proxy's MITM cert
    /// — they break under interception no matter what (e.g. PJe Office). A
    /// built-in base list (ALWAYS_BYPASS_APPS) is always applied on top.
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

    /// The hardcoded base bypass list, exposed read-only to the UI so users can
    /// see what's always tunneled regardless of their settings.
    pub fn pinned_hosts() -> Vec<String> {
        PINNED_HOSTS.iter().map(|s| s.to_string()).collect()
    }

    /// Built-in apps whose traffic is always tunneled, exposed read-only to the UI.
    pub fn pinned_apps() -> Vec<String> {
        ALWAYS_BYPASS_APPS.iter().map(|s| s.to_string()).collect()
    }

    /// Whether this client app's traffic should bypass interception (tunnel
    /// raw). Matches the built-in base list and the user's `skip_apps` as
    /// case-insensitive substrings of the resolved app name.
    pub fn should_skip_app(&self, app: &str) -> bool {
        let a = app.to_lowercase();
        if a.is_empty() { return false; }
        ALWAYS_BYPASS_APPS.iter().any(|p| a.contains(*p))
            || self.skip_apps.iter().any(|p| {
                let p = p.trim().to_lowercase();
                !p.is_empty() && a.contains(&p)
            })
    }

    /// Add a host (or `host:port`) to the skip-list if not already present.
    /// Returns true when it was newly added. Used by the adaptive auto-bypass
    /// to remember a host whose TLS interception failed.
    pub fn add_skip(&mut self, entry: &str) -> bool {
        let e = entry.trim().to_lowercase();
        if e.is_empty() || self.skip_hosts.iter().any(|h| h.trim().to_lowercase() == e) {
            return false;
        }
        self.skip_hosts.push(e);
        true
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
    pub fn should_intercept(&self, host: &str, port: u16) -> bool {
        if PINNED_HOSTS.iter().any(|p| matches_host(p, host)) {
            return false;
        }
        // Skip-list entries may pin a specific port (e.g. `localhost:8800`) so a
        // single loopback host can be partly tunneled (the signer port) and
        // partly captured (dev servers on other ports).
        if self.skip_hosts.iter().any(|p| matches_host_port(p, host, port)) {
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
    // NOTE: Brazilian judiciary (`*.jus.br`) used to live here, hardcoded. It's
    // now seeded into the user-editable skip-list (DEFAULT_SKIP_SEED) instead,
    // so users who want to inspect a tribunal can remove it, and the adaptive
    // auto-bypass re-adds anything that actually breaks under interception.
    // Misc known-pinned
    "*.twitter.com",
    "*.x.com",
    "*.twimg.com",
];

/// Like `matches_host`, but the pattern may carry a `:port` suffix. When it
/// does, the request port must match too (so `localhost:8800` tunnels only the
/// signer, not `localhost:3000`). A bare-host pattern matches any port.
fn matches_host_port(pattern: &str, host: &str, port: u16) -> bool {
    let p = pattern.trim();
    // Only treat a trailing `:NNNN` as a port; leave IPv6 / wildcards alone.
    if let Some((host_pat, port_pat)) = p.rsplit_once(':') {
        if let Ok(want) = port_pat.parse::<u16>() {
            return want == port && matches_host(host_pat, host);
        }
    }
    matches_host(p, host)
}

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

    fn settings(skip: &[&str]) -> SslSettings {
        SslSettings { mode: "all".into(), hosts: vec![], skip_hosts: skip.iter().map(|s| s.to_string()).collect(), skip_apps: vec![] }
    }

    #[test]
    fn pjeoffice_app_is_bypassed_by_default() {
        let s = settings(&[]);
        // Resolved bundle name is "PJeOffice-Pro" → matched by built-in "pjeoffice".
        assert!(s.should_skip_app("PJeOffice-Pro"));
        assert!(s.should_skip_app("pjeoffice"));
        // Unrelated apps are not.
        assert!(!s.should_skip_app("Google Chrome"));
        assert!(!s.should_skip_app(""));
    }

    #[test]
    fn user_skip_apps_match_substring() {
        let mut s = settings(&[]);
        s.skip_apps = vec!["MyBank".into()];
        assert!(s.should_skip_app("MyBank Desktop"));
        assert!(!s.should_skip_app("Safari"));
    }

    #[test]
    fn captures_everything_by_default() {
        // No skip entries → jus.br and any other host is intercepted (decrypted),
        // matching Fiddler's capture-all default.
        let s = settings(&[]);
        assert!(s.should_intercept("pje1g.trf1.jus.br", 443));
        assert!(s.should_intercept("sso.cloud.pje.jus.br", 443));
    }

    #[test]
    fn port_pinned_skip_only_matches_that_port() {
        let s = settings(&["localhost:8800"]);
        // signer port → tunnel (don't intercept)
        assert!(!s.should_intercept("localhost", 8800));
        // dev server on another port → still captured
        assert!(s.should_intercept("localhost", 3000));
    }

    #[test]
    fn bare_host_skip_matches_any_port() {
        let s = settings(&["*.jus.br"]);
        assert!(!s.should_intercept("pje.trt2.jus.br", 443));
        assert!(!s.should_intercept("pje.trt2.jus.br", 8443));
    }

    #[test]
    fn jus_br_not_hardcoded_anymore() {
        // With no skip entry, a tribunal host is intercepted like anything else.
        let s = settings(&[]);
        assert!(s.should_intercept("pje.trt2.jus.br", 443));
    }

    #[test]
    fn pinned_base_still_tunneled() {
        let s = settings(&[]);
        assert!(!s.should_intercept("media.whatsapp.net", 443));
    }

    #[test]
    fn ipv6_literal_does_not_break_port_parse() {
        let s = settings(&["[::1]"]);
        // No spurious port match; "[::1]" exact-matches the host.
        assert!(!s.should_intercept("[::1]", 443));
    }

    #[test]
    fn add_skip_dedups() {
        let mut s = settings(&["*.jus.br"]);
        assert!(!s.add_skip("*.jus.br"));      // already present
        assert!(s.add_skip("bank.example.com")); // new
        assert!(!s.add_skip("BANK.example.com")); // case-insensitive dup
    }
}
