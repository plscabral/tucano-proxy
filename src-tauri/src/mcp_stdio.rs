//! stdio ↔ HTTP bridge for clients that only speak the stdio MCP transport.
//!
//! Claude Desktop's `claude_desktop_config.json` only accepts stdio servers
//! (`command` + `args`) — it rejects `type: http` / `url` entries as invalid.
//! Rather than depend on Node/npx (`mcp-remote`), we spawn Tucano's own binary
//! in this mode: `tucano-proxy mcp-stdio`. It reads newline-delimited JSON-RPC
//! on stdin, forwards each message to the running app's native Streamable-HTTP
//! `/mcp` endpoint with the bearer token, and writes responses back on stdout.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Entry point for the `mcp-stdio` subcommand. Reads the target URL and token
/// from the environment (set by the installer), then runs the bridge on a
/// single-threaded runtime until stdin closes.
pub fn run() {
    let url = std::env::var("TUCANO_MCP_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:7878/mcp".to_string());
    let token = std::env::var("TUCANO_MCP_TOKEN").unwrap_or_default();

    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[mcp-stdio] runtime: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = rt.block_on(bridge(url, token)) {
        eprintln!("[mcp-stdio] {e}");
        std::process::exit(1);
    }
}

async fn bridge(
    url: String,
    token: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let connector = crate::http_client::build_connector()?;
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build::<_, Full<Bytes>>(connector);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Remember the request id so a transport failure can still produce a
        // well-formed JSON-RPC error instead of leaving the client hanging.
        let id = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v.get("id").cloned());

        match forward(&client, &url, &token, line).await {
            // A request → write the server's single-line JSON response.
            Ok(Some(resp)) => {
                stdout.write_all(resp.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            // 202 Accepted (a notification) → nothing to write back.
            Ok(None) => {}
            // Couldn't reach the app (likely not running). Surface it as a
            // JSON-RPC error for requests; stay silent for notifications.
            Err(e) => {
                if let Some(id) = id {
                    let err = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32000,
                            "message": format!("Tucano not reachable — is the app running? ({e})"),
                        },
                    });
                    stdout.write_all(err.to_string().as_bytes()).await?;
                    stdout.write_all(b"\n").await?;
                    stdout.flush().await?;
                }
            }
        }
    }
    Ok(())
}

/// POST one JSON-RPC line to the HTTP endpoint. Returns the response body for
/// requests, or `None` when the server replies 202 (notifications) or empty.
async fn forward(
    client: &hyper_util::client::legacy::Client<
        hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
        Full<Bytes>,
    >,
    url: &str,
    token: &str,
    line: &str,
) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
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
    if res.status() == http::StatusCode::ACCEPTED {
        return Ok(None);
    }
    let body = res.into_body().collect().await?.to_bytes();
    let body = String::from_utf8_lossy(&body);
    let body = body.trim();
    if body.is_empty() {
        return Ok(None);
    }
    Ok(Some(body.to_string()))
}
