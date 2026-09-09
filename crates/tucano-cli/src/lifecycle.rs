use crate::client::{fail, Client, Runtime};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn data_root(path: Option<&PathBuf>) -> Result<PathBuf> {
    let path = match path {
        Some(path) => path.clone(),
        None => dirs::data_local_dir()
            .context("Cannot locate user data directory; use --data-dir")?
            .join("tucano-proxy"),
    };
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
pub async fn connect(root: &Path, session: &str, timeout: u64) -> Result<(Runtime, Client)> {
    let runtime = Runtime::read(root, session)?;
    let client = Client::new(&runtime, timeout)?;
    client.verify(&runtime).await?;
    Ok((runtime, client))
}
pub fn browser_open(runtime: &Runtime, token: &str) -> Result<()> {
    let url = format!("{}/#token={token}", runtime.endpoint.trim_end_matches('/'));
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("Could not launch platform browser opener")?;
    if !status.success() {
        return Err(fail(
            "browser_open_failed",
            "Platform browser opener failed; use auth show --scope admin to authenticate manually",
            6,
        ));
    }
    Ok(())
}
pub fn summary(runtime: &Runtime) -> Value {
    json!({"running":true,"session":runtime.session,"endpoint":runtime.endpoint,"proxyPort":runtime.proxy_port,"instanceId":runtime.instance_id,"persistent":true})
}
/// One graceful shutdown, confirmed by the runtime descriptor disappearing or
/// being replaced. Shared by `stop` and `stop --all`.
pub async fn stop(root: &Path, session: &str, timeout: u64) -> Result<Value> {
    let (runtime, client) = connect(root, session, timeout).await?;
    client.shutdown(&runtime).await?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        match Runtime::read(root, session) {
            Err(error) if crate::client::unavailable(&error) => break,
            Ok(current) if current.instance_id != runtime.instance_id => break,
            Err(error) => return Err(error),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(fail("shutdown_timeout","Shutdown was requested but runtime descriptor remains; inspect service.log before retrying",3));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(json!({"session":session,"running":false}))
}

/// Stops every session that answers in this data directory. Sessions that are
/// already down are reported, not treated as failures; a session that refuses
/// to stop never hides the ones that did.
pub async fn stop_all(root: &Path, timeout: u64) -> Result<Value> {
    let mut stopped = Vec::new();
    let mut already_stopped = Vec::new();
    let mut failed = Vec::new();
    for session in tucano_service::list_sessions(root)? {
        match connect(root, &session, timeout.min(2)).await {
            Ok(_) => match stop(root, &session, timeout).await {
                Ok(_) => stopped.push(session),
                Err(error) => failed.push(json!({
                    "session": session,
                    "detail": crate::output::clean(&error.to_string()),
                })),
            },
            Err(error) if crate::client::unavailable(&error) => already_stopped.push(session),
            Err(error) => failed.push(json!({
                "session": session,
                "detail": crate::output::clean(&error.to_string()),
            })),
        }
    }
    if !failed.is_empty() {
        return Err(fail(
            "stop_incomplete",
            format!(
                "Stopped {}; still running: {}. Inspect service.log for each and retry.",
                if stopped.is_empty() {
                    "no session".to_string()
                } else {
                    stopped.join(", ")
                },
                failed
                    .iter()
                    .map(|item| item["session"].as_str().unwrap_or("?").to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            6,
        ));
    }
    Ok(json!({"stopped":stopped,"alreadyStopped":already_stopped}))
}
/// Two running services must not claim the same proxy port: only one can hold
/// the listener, so the other silently captures nothing. Mark both rows rather
/// than reporting a port that belongs to a different session.
pub fn annotate_port_conflicts(items: &mut [Value]) {
    let mut seen: HashMap<u64, usize> = HashMap::new();
    for item in items.iter() {
        if let Some(port) = item.get("proxyPort").and_then(Value::as_u64) {
            *seen.entry(port).or_default() += 1;
        }
    }
    for item in items.iter_mut() {
        let shared = item
            .get("proxyPort")
            .and_then(Value::as_u64)
            .is_some_and(|port| seen.get(&port).copied().unwrap_or(0) > 1);
        if shared {
            item["proxyPortConflict"] = json!(true);
        }
    }
}
pub async fn ensure(
    root: &Path,
    session: &str,
    timeout: u64,
    web_port: Option<u16>,
    proxy_port: Option<u16>,
    capture: bool,
    system_proxy: bool,
) -> Result<(Runtime, Client)> {
    let existing = match Runtime::read(root, session) {
        Ok(runtime) => Some(runtime),
        Err(error)
            if error
                .downcast_ref::<crate::client::Failure>()
                .is_some_and(|error| error.exit == 3) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    if let Some(runtime) = existing {
        let client = Client::new(&runtime, timeout.min(2))?;
        match client.verify(&runtime).await {
            Ok(_) => {
                if web_port.is_some_and(|port| {
                    reqwest::Url::parse(&runtime.endpoint)
                        .ok()
                        .and_then(|url| url.port_or_known_default())
                        != Some(port)
                }) {
                    return Err(fail("port_conflict", "Session is already running on another web port; stop it before changing ports", 6));
                }
                let client = Client::new(&runtime, timeout)?;
                if capture {
                    let proxy_port = match proxy_port {
                        Some(port) => port,
                        None => client.invoke("get_status", json!({})).await?["port"]
                            .as_u64()
                            .and_then(|port| u16::try_from(port).ok())
                            .context("Service returned an invalid proxy port")?,
                    };
                    client
                        .invoke(
                            if system_proxy {
                                "start_capture"
                            } else {
                                "start_proxy"
                            },
                            json!({"port":proxy_port}),
                        )
                        .await?;
                }
                return Ok((runtime, client));
            }
            Err(error) => {
                if error
                    .downcast_ref::<crate::client::Failure>()
                    .is_none_or(|error| error.exit != 3)
                {
                    return Err(error);
                }
            }
        }
    }
    if std::env::var("TUCANO_TOKEN").is_ok_and(|token| !token.is_empty()) {
        return Err(fail("service_unavailable", "The session is not reachable. TUCANO_TOKEN authenticates an existing instance and cannot bootstrap a new one; unset it before explicitly starting a new service.", 3));
    }
    let (proxy_port, web_port) = crate::setup::resolve_ports(root, session, proxy_port, web_port)?;
    let directory = tucano_service::create_session(root, session)?;
    let log_path = directory.join("service.log");
    let mut log_options = std::fs::OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let log = log_options
        .open(&log_path)
        .context("Cannot open service log")?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("--data-dir")
        .arg(root)
        .arg("--session")
        .arg(session)
        .arg("serve")
        .arg("--proxy-port")
        .arg(proxy_port.to_string())
        .arg("--web-port")
        .arg(web_port.to_string());
    if !capture {
        command.arg("--no-capture");
    }
    if system_proxy {
        command.arg("--system-proxy").arg("--yes");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200);
    }
    let mut child = command
        .spawn()
        .context("Cannot launch independent service process")?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(fail(
                "service_start_failed",
                format!(
                    "Service exited with {status}; inspect {}",
                    log_path.display()
                ),
                6,
            ));
        }
        if let Ok(pair) = connect(root, session, 1).await {
            return Ok((pair.0.clone(), Client::new(&pair.0, timeout)?));
        }
        if Instant::now() >= deadline {
            return Err(fail("readiness_timeout", format!("Service did not become ready in {timeout}s. Child was not killed and may still be starting; inspect {} and run status/stop.", log_path.display()), 3));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
pub async fn foreground(
    options: tucano_service::ServeOptions,
    timeout: u64,
    open: bool,
) -> Result<Value> {
    let session = options.session.clone();
    let opener = if open {
        let root = options.data_dir.clone();
        let session = session.clone();
        Some(tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(timeout);
            while Instant::now() < deadline {
                if let Ok((runtime, client)) = connect(&root, &session, 1).await {
                    if let Err(error) = browser_open(&runtime, &client.token) {
                        eprintln!("{}", crate::output::clean(&error.to_string()));
                    }
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            eprintln!("Browser was not opened: service readiness timed out");
        }))
    } else {
        None
    };
    let result = tucano_service::serve(options).await;
    if let Some(opener) = opener {
        opener.abort();
    }
    result?;
    Ok(json!({"session":session,"running":false}))
}

#[cfg(test)]
mod tests {
    use super::annotate_port_conflicts;
    use serde_json::json;

    #[test]
    fn marks_every_session_sharing_a_proxy_port() {
        let mut items = vec![
            json!({"session":"a","running":true,"proxyPort":8888}),
            json!({"session":"b","running":true,"proxyPort":8889}),
            json!({"session":"c","running":true,"proxyPort":8888}),
            json!({"session":"d","running":false}),
        ];
        annotate_port_conflicts(&mut items);
        assert_eq!(items[0]["proxyPortConflict"], json!(true));
        assert_eq!(items[2]["proxyPortConflict"], json!(true));
        assert!(items[1].get("proxyPortConflict").is_none());
        assert!(items[3].get("proxyPortConflict").is_none());
    }
}
