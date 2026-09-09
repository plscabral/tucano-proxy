//! stdio ↔ HTTP bridge for clients that only speak the stdio MCP transport.
//!
//! Claude Desktop's `claude_desktop_config.json` only accepts stdio servers
//! (`command` + `args`) — it rejects `type: http` / `url` entries as invalid.
//! Rather than depend on Node/npx (`mcp-remote`), we spawn Tucano's own binary
//! in this mode: `tucano-proxy mcp-stdio`. It reads newline-delimited JSON-RPC
//! on stdin and writes responses back on stdout.
//!
//! `initialize`, `ping` and `tools/list` are answered locally, without the
//! app needing to be open — a client's startup handshake never depends on
//! Tucano actually running. Only `tools/call` needs the app: if it can't be
//! reached, that comes back as a normal (non-error) JSON-RPC result with
//! `isError: true` so the client shows it as tool output, not a transport
//! failure.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{sleep, Instant};

use crate::mcp_bridge;

type HttpClient = hyper_util::client::legacy::Client<
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    Full<Bytes>,
>;

const NOT_RUNNING_MESSAGE: &str = "Tucano Proxy is not running. Open the Tucano Proxy app (and enable Settings > MCP) and try again.";
const STALE_TOKEN_MESSAGE: &str = "Tucano Proxy rejected this token. Reinstall the MCP integration from Settings > MCP in the Tucano Proxy app and try again.";

struct SessionLaunch {
    root: PathBuf,
    session: String,
}

struct BridgeOptions {
    url: String,
    token: String,
    autolaunch: bool,
    launch: Option<SessionLaunch>,
    disabled_message: Option<String>,
}

#[derive(Default)]
struct Overrides {
    url: Option<String>,
    token: Option<String>,
    autolaunch: Option<bool>,
    root: Option<PathBuf>,
    session: Option<String>,
}
impl Overrides {
    fn read() -> Self {
        Self {
            url: std::env::var("TUCANO_MCP_URL").ok(),
            token: std::env::var("TUCANO_MCP_TOKEN").ok(),
            autolaunch: std::env::var("TUCANO_MCP_AUTOLAUNCH")
                .ok()
                .map(|value| value == "1"),
            root: std::env::var_os("TUCANO_MCP_DATA_DIR").map(PathBuf::from),
            session: std::env::var("TUCANO_MCP_SESSION").ok(),
        }
    }
}

/// Desktop entrypoint retains the environment-only installation contract.
pub fn run() {
    let overrides = Overrides::read();
    let launch = overrides
        .root
        .zip(overrides.session)
        .map(|(root, session)| SessionLaunch { root, session });
    let options = BridgeOptions {
        url: overrides
            .url
            .unwrap_or_else(|| "http://127.0.0.1:7878/mcp".into()),
        token: overrides.token.unwrap_or_default(),
        autolaunch: overrides.autolaunch.unwrap_or(false),
        launch,
        disabled_message: None,
    };
    if let Err(error) = run_bridge(options) {
        eprintln!("[mcp-stdio] {error}");
        std::process::exit(1);
    }
}

/// Headless entrypoint. Resolves only an existing selected session; never creates or enables MCP.
pub fn run_for_session(root: PathBuf, session: String) -> crate::state::BoxResult<()> {
    run_bridge(session_options(root, session, Overrides::read())?)
}

fn session_options(
    root: PathBuf,
    session: String,
    overrides: Overrides,
) -> crate::state::BoxResult<BridgeOptions> {
    let root = overrides.root.unwrap_or(root).canonicalize()?;
    let session = overrides.session.unwrap_or(session);
    if session.is_empty()
        || session.len() > 64
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(
            "session names must contain 1–64 ASCII letters, digits, underscores or hyphens".into(),
        );
    }
    let upper = session.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("session name is reserved by the operating system".into());
    }
    let directory = root.join("sessions").join(&session);
    if std::fs::symlink_metadata(&directory)?
        .file_type()
        .is_symlink()
    {
        return Err("session directory must not be a symbolic link".into());
    }
    // McpSettings::load may initialize a token; this bridge intentionally performs a read only.
    let bytes = std::fs::read(directory.join("mcp-settings.json"))
        .map_err(|error| format!("cannot read MCP settings for session '{session}': {error}"))?;
    let settings: crate::mcp_settings::McpSettings = serde_json::from_slice(&bytes)?;
    let explicit_target = overrides.url.is_some();
    let disabled_message=(!settings.enabled && !explicit_target).then(||format!(
        "MCP is disabled for Tucano Proxy session '{session}'. Enable MCP for this session explicitly before calling tools."
    ));
    Ok(BridgeOptions {
        url: overrides
            .url
            .unwrap_or_else(|| format!("http://127.0.0.1:{}/mcp", settings.port)),
        token: overrides.token.unwrap_or(settings.token),
        autolaunch: overrides.autolaunch.unwrap_or(settings.autolaunch),
        launch: Some(SessionLaunch { root, session }),
        disabled_message,
    })
}

fn run_bridge(options: BridgeOptions) -> crate::state::BoxResult<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(bridge(options))
}

async fn bridge(options: BridgeOptions) -> crate::state::BoxResult<()> {
    let connector = crate::http_client::build_connector()?;
    let client: HttpClient =
        hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(connector);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    // Autolaunch fires at most once per bridge process, even if several
    // tools/call requests fail while the app is still starting up.
    let mut launched = false;

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[mcp-stdio] invalid JSON-RPC line: {e}");
                continue;
            }
        };

        // No id → notification. We never reply, and we never touch the
        // network for one — the app is stateless per-request anyway.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

        let out: String = match method {
            "initialize" => {
                let proto = msg
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str());
                mcp_bridge::rpc_ok(id, mcp_bridge::initialize_result(proto)).to_string()
            }
            "ping" => mcp_bridge::rpc_ok(id, json!({})).to_string(),
            "tools/list" => {
                mcp_bridge::rpc_ok(id, json!({ "tools": mcp_bridge::tools_list() })).to_string()
            }
            "tools/call" => handle_tools_call(&client, &options, id, line, &mut launched).await,
            other => {
                mcp_bridge::rpc_err(id, -32601, &format!("method not found: {other}")).to_string()
            }
        };

        stdout.write_all(out.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

/// Forward a `tools/call` request to the app's HTTP endpoint. On any
/// connectivity/auth failure, returns a `result` (never a JSON-RPC error) so
/// the client renders it as tool output.
async fn handle_tools_call(
    client: &HttpClient,
    options: &BridgeOptions,
    id: Value,
    line: &str,
    launched: &mut bool,
) -> String {
    if let Some(message) = &options.disabled_message {
        return mcp_bridge::rpc_ok(
            id,
            json!({
                "content":[{"type":"text","text":message}],"isError":true
            }),
        )
        .to_string();
    }
    let url = &options.url;
    let token = &options.token;
    match forward(client, url, token, line).await {
        Ok(ForwardOutcome::Body(body)) => body,
        Ok(ForwardOutcome::Empty) => not_reachable_result(id, options.launch.as_ref()).to_string(),
        Ok(ForwardOutcome::Unauthorized) => {
            unauthorized_result(id, options.launch.as_ref()).to_string()
        }
        Err(e) => {
            eprintln!("[mcp-stdio] tools/call: Tucano not reachable ({e})");
            if options.autolaunch && !*launched {
                *launched = true;
                launch_app(options.launch.as_ref());
                poll_until_reachable(client, url, token, Duration::from_secs(10)).await;
                match forward(client, url, token, line).await {
                    Ok(ForwardOutcome::Body(body)) => body,
                    Ok(ForwardOutcome::Unauthorized) => {
                        unauthorized_result(id, options.launch.as_ref()).to_string()
                    }
                    _ => not_reachable_result(id, options.launch.as_ref()).to_string(),
                }
            } else {
                not_reachable_result(id, options.launch.as_ref()).to_string()
            }
        }
    }
}

fn not_reachable_result(id: Value, launch: Option<&SessionLaunch>) -> Value {
    let message=launch.map(|launch|format!("Tucano Proxy session '{}' is not reachable. Start that session and ensure its MCP endpoint is enabled.",launch.session))
        .unwrap_or_else(||NOT_RUNNING_MESSAGE.into());
    mcp_bridge::rpc_ok(
        id,
        json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        }),
    )
}

fn unauthorized_result(id: Value, launch: Option<&SessionLaunch>) -> Value {
    let message=launch.map(|launch|format!("Tucano Proxy session '{}' rejected the MCP token. Refresh its MCP client integration or explicit token override.",launch.session))
        .unwrap_or_else(||STALE_TOKEN_MESSAGE.into());
    mcp_bridge::rpc_ok(
        id,
        json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        }),
    )
}

enum ForwardOutcome {
    /// A JSON-RPC response body, forwarded verbatim.
    Body(String),
    /// 202 Accepted or an empty body — nothing to relay.
    Empty,
    /// 401 — the bearer token doesn't match what the app expects.
    Unauthorized,
}

/// POST one JSON-RPC line to the HTTP endpoint.
async fn forward(
    client: &HttpClient,
    url: &str,
    token: &str,
    line: &str,
) -> Result<ForwardOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let mut builder = http::Request::builder()
        .method(http::Method::POST)
        .uri(url)
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(http::header::ACCEPT, "application/json");
    if !token.is_empty() {
        builder = builder.header(http::header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let req = builder.body(Full::new(Bytes::from(line.to_string())))?;

    let res = client.request(req).await?;
    let status = res.status();
    if status == http::StatusCode::UNAUTHORIZED {
        return Ok(ForwardOutcome::Unauthorized);
    }
    if status == http::StatusCode::ACCEPTED {
        return Ok(ForwardOutcome::Empty);
    }
    let body = res.into_body().collect().await?.to_bytes();
    let body = String::from_utf8_lossy(&body);
    let body = body.trim();
    if body.is_empty() {
        return Ok(ForwardOutcome::Empty);
    }
    Ok(ForwardOutcome::Body(body.to_string()))
}

/// Poll the HTTP endpoint until it responds or `timeout` elapses. Used only
/// after an autolaunch attempt, to give the app a chance to boot before we
/// retry the original `tools/call`.
async fn poll_until_reachable(client: &HttpClient, url: &str, token: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let ping = json!({ "jsonrpc": "2.0", "id": "__tucano_autolaunch_poll__", "method": "ping", "params": {} })
        .to_string();
    loop {
        if forward(client, url, token, &ping).await.is_ok() {
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        sleep(Duration::from_millis(300)).await;
    }
}

/// Try to start the Tucano app so a follow-up `tools/call` has a chance of
/// succeeding. Best-effort: failures are logged to stderr and otherwise
/// ignored, since the caller falls back to the "not running" message anyway.
fn launch_app(launch: Option<&SessionLaunch>) {
    eprintln!("[mcp-stdio] autolaunch: attempting to start Tucano Proxy");
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[mcp-stdio] autolaunch: current_exe failed: {e}");
            return;
        }
    };
    if let Some(launch) = launch {
        if let Err(error) = std::process::Command::new(&exe)
            .arg("--data-dir")
            .arg(&launch.root)
            .args(["--session", &launch.session, "start"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            eprintln!("[mcp-stdio] autolaunch: service start failed: {error}");
        }
        return;
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS the running binary lives at
        // `<bundle>.app/Contents/MacOS/tucano-proxy`; launching that binary
        // directly wouldn't register it as a normal GUI app, so find the
        // enclosing `.app` and let `open` launch it properly.
        let bundle = exe
            .ancestors()
            .find(|p| p.extension().map(|e| e == "app").unwrap_or(false));
        match bundle {
            Some(bundle) => {
                if let Err(e) = std::process::Command::new("open")
                    .arg("-a")
                    .arg(bundle)
                    .spawn()
                {
                    eprintln!("[mcp-stdio] autolaunch: `open -a` failed: {e}");
                }
            }
            None => {
                if let Err(e) = std::process::Command::new(&exe)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    eprintln!("[mcp-stdio] autolaunch: spawn failed: {e}");
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Err(e) = std::process::Command::new(&exe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            eprintln!("[mcp-stdio] autolaunch: spawn failed: {e}");
        }
    }
}
