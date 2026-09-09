use crate::{ApiError, RuntimeDescriptor};
use axum::http::{header, HeaderMap};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Admin,
    Read,
}
impl Scope {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Read => "read",
        }
    }
}

pub(crate) fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut output = String::with_capacity(64);
    const HEX: &[u8] = b"0123456789abcdef";
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}
fn same(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

pub(crate) struct Credentials {
    pub descriptor: RuntimeDescriptor,
    pub cookie_name: String,
    admin_cookie: String,
    read_cookie: String,
}
impl Credentials {
    pub(crate) fn new(descriptor: RuntimeDescriptor) -> Self {
        let cookie_name = format!("tucano_{}", descriptor.instance_id.replace('-', ""));
        Self {
            descriptor,
            cookie_name,
            admin_cookie: secret(),
            read_cookie: secret(),
        }
    }
    pub(crate) fn token_scope(&self, token: &str) -> Option<Scope> {
        if same(token, &self.descriptor.token) {
            Some(Scope::Admin)
        } else if same(token, &self.descriptor.read_token) {
            Some(Scope::Read)
        } else {
            None
        }
    }
    pub(crate) fn authenticate(&self, headers: &HeaderMap) -> Result<Scope, ApiError> {
        if headers.get_all(header::AUTHORIZATION).iter().count() > 1 {
            return Err(ApiError::unauthorized());
        }
        if let Some(value) = headers.get(header::AUTHORIZATION) {
            return value
                .to_str()
                .ok()
                .and_then(|value| value.strip_prefix("Bearer "))
                .and_then(|token| self.token_scope(token))
                .ok_or_else(ApiError::unauthorized);
        }
        for cookies in headers.get_all(header::COOKIE) {
            if let Ok(cookies) = cookies.to_str() {
                for cookie in cookies.split(';') {
                    if let Some((name, token)) = cookie.trim().split_once('=') {
                        if name == self.cookie_name {
                            if same(token, &self.admin_cookie) {
                                return Ok(Scope::Admin);
                            }
                            if same(token, &self.read_cookie) {
                                return Ok(Scope::Read);
                            }
                        }
                    }
                }
            }
        }
        Err(ApiError::unauthorized())
    }
    pub(crate) fn cookie(&self, scope: Scope) -> String {
        let token = match scope {
            Scope::Admin => &self.admin_cookie,
            Scope::Read => &self.read_cookie,
        };
        format!(
            "{}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
            self.cookie_name
        )
    }
    pub(crate) fn commit_rotation(&mut self, descriptor: RuntimeDescriptor, scope: Scope) {
        self.descriptor = descriptor;
        match scope {
            Scope::Admin => self.admin_cookie = secret(),
            Scope::Read => self.read_cookie = secret(),
        }
    }
}

pub(crate) fn check_source(headers: &HeaderMap, port: u16) -> Result<(), ApiError> {
    if headers.get_all(header::HOST).iter().count() != 1 {
        return Err(ApiError::forbidden("a single loopback Host is required"));
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{port}")
        && host != format!("localhost:{port}")
        && !(port == 80 && matches!(host, "127.0.0.1" | "localhost"))
    {
        return Err(ApiError::forbidden(
            "Host must match this loopback listener",
        ));
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1 {
        return Err(ApiError::forbidden("multiple origins are not allowed"));
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin_host = if port == 80 {
            host.strip_suffix(":80").unwrap_or(host)
        } else {
            host
        };
        if origin.to_str().ok() != Some(format!("http://{origin_host}").as_str()) {
            return Err(ApiError::forbidden("cross-origin requests are not allowed"));
        }
    }
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden("cross-site requests are not allowed"));
    }
    Ok(())
}

pub(crate) fn command_scope(command: &str) -> Option<Scope> {
    Some(match command {
        "get_status" | "get_private_mode" | "list_flows" | "get_flow" | "query_flows"
        | "get_stats" | "get_version" | "export_flows" | "export_ca" | "get_ssl_settings"
        | "get_keep_limit" => Scope::Read,
        // MCP settings include another credential and are never available to a
        // read-only service credential. Unknown future commands fail closed.
        "start_proxy"
        | "stop_proxy"
        | "start_capture"
        | "stop_capture"
        | "install_ca"
        | "uninstall_ca"
        | "toggle_system_proxy"
        | "set_private_mode"
        | "clear_flows"
        | "delete_flows"
        | "restore_flows"
        | "update_flow_note"
        | "update_flow_mark"
        | "replay_flow"
        | "compose_request"
        | "set_ssl_settings"
        | "set_keep_limit"
        | "get_mcp_settings"
        | "set_mcp_settings"
        | "rotate_mcp_token"
        | "list_mcp_clients"
        | "mcp_binary_path"
        | "install_mcp_client"
        | "uninstall_mcp_client" => Scope::Admin,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn credentials() -> Credentials {
        Credentials::new(RuntimeDescriptor {
            api_version: 1,
            session: "work".into(),
            pid: 1,
            endpoint: "http://127.0.0.1:7777".into(),
            token: secret(),
            read_token: secret(),
            proxy_port: 8888,
            started_at: 1,
            instance_id: "instance".into(),
        })
    }
    #[test]
    fn blocks_rebinding_cross_origin_and_credential_confusion() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "evil.example:7777".parse().unwrap());
        assert!(check_source(&headers, 7777).is_err());
        headers.insert(header::HOST, "127.0.0.1:7777".parse().unwrap());
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(check_source(&headers, 7777).is_err());
        headers.insert(header::ORIGIN, "http://127.0.0.1:7777".parse().unwrap());
        assert!(check_source(&headers, 7777).is_ok());
        let creds = credentials();
        headers.insert(header::COOKIE, creds.cookie(Scope::Admin).parse().unwrap());
        headers.insert(header::AUTHORIZATION, "Bearer invalid".parse().unwrap());
        assert!(creds.authenticate(&headers).is_err());
        headers.remove(header::AUTHORIZATION);
        assert_eq!(creds.authenticate(&headers).unwrap(), Scope::Admin);
    }
    #[test]
    fn rotation_revokes_tokens_and_cookies_only_in_selected_scope() {
        let mut creds = credentials();
        let old = creds.descriptor.read_token.clone();
        let admin = creds.descriptor.token.clone();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, creds.cookie(Scope::Read).parse().unwrap());
        let mut next = creds.descriptor.clone();
        next.read_token = secret();
        creds.commit_rotation(next, Scope::Read);
        assert!(creds.authenticate(&headers).is_err());
        assert_eq!(creds.token_scope(&old), None);
        assert_eq!(creds.token_scope(&admin), Some(Scope::Admin));
        assert_eq!(command_scope("clear_flows"), Some(Scope::Admin));
        assert_eq!(command_scope("query_flows"), Some(Scope::Read));
        assert_eq!(command_scope("get_mcp_settings"), Some(Scope::Admin));
        for blocked in [
            "save_session",
            "open_session",
            "write_text_file",
            "write_binary_file",
            "quit_app",
            "future_command",
        ] {
            assert_eq!(command_scope(blocked), None);
        }
    }
}
