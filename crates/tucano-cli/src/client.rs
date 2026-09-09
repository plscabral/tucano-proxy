use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub exit: i32,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}
pub fn fail(code: &'static str, message: impl Into<String>, exit: i32) -> anyhow::Error {
    Failure {
        code,
        message: message.into(),
        exit,
    }
    .into()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub api_version: u32,
    pub session: String,
    pub endpoint: String,
    pub token: String,
    pub read_token: String,
    pub proxy_port: u16,
    pub instance_id: String,
}
impl Runtime {
    pub fn read(root: &Path, session: &str) -> Result<Self> {
        let path = tucano_service::session_path(root, session)?.join("runtime.json");
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                fail(
                    "service_unavailable",
                    format!("No running service for session {session}. Run tucano-proxy start."),
                    3,
                )
            } else {
                fail(
                    "unsafe_runtime",
                    format!("Cannot safely open runtime descriptor: {error}"),
                    4,
                )
            }
        })?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(fail(
                "unsafe_runtime",
                "Runtime descriptor must be a regular, non-symlink file",
                4,
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err(fail("unsafe_runtime", "Runtime descriptor must be owned by the current user and have owner-only permissions", 4));
            }
        }
        let runtime: Self = serde_json::from_reader(file).context("Invalid runtime descriptor")?;
        if runtime.api_version != 1 || runtime.session != session {
            return Err(fail(
                "invalid_runtime",
                "Runtime descriptor version/session does not match",
                4,
            ));
        }
        let url = reqwest::Url::parse(&runtime.endpoint)?;
        if url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("127.0.0.1") | Some("[::1]") | Some("::1")
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(fail(
                "unsafe_runtime",
                "Runtime endpoint must be an uncredentialed loopback HTTP origin",
                4,
            ));
        }
        Ok(runtime)
    }
}

#[derive(Clone)]
pub struct Client {
    pub endpoint: String,
    pub token: String,
    http: reqwest::Client,
}
impl Client {
    pub fn new(runtime: &Runtime, timeout: u64) -> Result<Self> {
        let token = match std::env::var("TUCANO_TOKEN") {
            Ok(value) if !value.is_empty() => value,
            _ => runtime.token.clone(),
        };
        Ok(Self {
            endpoint: runtime.endpoint.trim_end_matches('/').to_owned(),
            token,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(timeout))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
        })
    }
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.endpoint)
    }
    async fn response(&self, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .context("Service returned invalid JSON")?;
        if !status.is_success() || value.get("error").is_some() {
            let message = value["error"]["message"]
                .as_str()
                .unwrap_or("Service rejected operation");
            return Err(fail(
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    "authentication_failed"
                } else {
                    "operation_failed"
                },
                message,
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    4
                } else {
                    6
                },
            ));
        }
        if value["apiVersion"] != 1 {
            return Err(anyhow!("Unsupported service API version"));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Service response has no result"))
    }
    fn unavailable(error: reqwest::Error) -> anyhow::Error {
        fail(
            "service_unavailable",
            format!("Cannot reach local service: {error}"),
            3,
        )
    }
    pub async fn invoke(&self, command: &str, args: Value) -> Result<Value> {
        let response = self
            .http
            .post(self.url("/api/v1/invoke"))
            .bearer_auth(&self.token)
            .json(&json!({"command":command,"args":args}))
            .send()
            .await
            .map_err(Self::unavailable)?;
        self.response(response).await
    }
    pub async fn identity(&self) -> Result<Value> {
        let response = self
            .http
            .get(self.url("/api/v1/runtime"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(Self::unavailable)?;
        self.response(response).await
    }
    pub async fn verify(&self, runtime: &Runtime) -> Result<Value> {
        let identity = self.identity().await?;
        if identity["instanceId"] != runtime.instance_id || identity["session"] != runtime.session {
            return Err(fail(
                "identity_mismatch",
                "Service identity differs from local runtime descriptor; refusing operation",
                4,
            ));
        }
        Ok(identity)
    }
    pub async fn shutdown(&self, runtime: &Runtime) -> Result<Value> {
        self.verify(runtime).await?;
        let response = self
            .http
            .post(self.url("/api/v1/shutdown"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(Self::unavailable)?;
        self.response(response).await
    }
    pub async fn rotate(&self, scope: &str) -> Result<Value> {
        let response = self
            .http
            .post(self.url("/api/v1/auth/rotate"))
            .bearer_auth(&self.token)
            .json(&json!({"scope":scope}))
            .send()
            .await
            .map_err(Self::unavailable)?;
        self.response(response).await
    }
    pub async fn export_session(&self, ids: Option<&[String]>) -> Result<Vec<u8>> {
        let mut request = self
            .http
            .get(self.url("/api/v1/session/export"))
            .bearer_auth(&self.token);
        if let Some(ids) = ids {
            request = request.query(&[("ids", ids.join(","))]);
        }
        let response = request.send().await.map_err(Self::unavailable)?;
        if !response.status().is_success() {
            self.response(response).await?;
            return Err(anyhow!("Invalid session export response"));
        }
        Ok(response.bytes().await?.to_vec())
    }
    pub async fn import_session(&self, bytes: Vec<u8>) -> Result<Value> {
        let response = self
            .http
            .post(self.url("/api/v1/session/import"))
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/vnd.sqlite3")
            .body(bytes)
            .send()
            .await
            .map_err(Self::unavailable)?;
        self.response(response).await
    }
}
