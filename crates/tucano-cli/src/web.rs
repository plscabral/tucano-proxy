use crate::{
    args::WebTarget,
    client::{fail, Runtime},
    lifecycle,
};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    io::{self, IsTerminal, Write},
    process::Stdio,
    time::Duration,
};

fn env_value(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

fn in_maestri() -> bool {
    // Presence of the app alone is insufficient: portals belong to a specific terminal.
    env_value("MAESTRI_SOCKET").is_some() && env_value("MAESTRI_TERMINAL_ID").is_some()
}

fn in_orca() -> bool {
    std::env::var("TERM_PROGRAM").is_ok_and(|value| value.eq_ignore_ascii_case("Orca"))
        || env_value("ORCA_CLI_COMMAND").is_some()
        || env_value("ORCA_DEV_REPO_ROOT").is_some()
}

fn orca_executable() -> OsString {
    if let Some(command) = env_value("ORCA_CLI_COMMAND") {
        command
    } else if env_value("ORCA_DEV_REPO_ROOT").is_some() {
        "orca-dev".into()
    } else if cfg!(target_os = "linux") && !in_orca() {
        // Outside managed Linux terminals, `orca` may be the GNOME screen reader.
        "orca-ide".into()
    } else {
        "orca".into()
    }
}

pub async fn open(
    runtime: &Runtime,
    token: &str,
    target: WebTarget,
    json_mode: bool,
    timeout: u64,
) -> Result<Option<&'static str>> {
    let selected = match target {
        WebTarget::Auto => {
            let (detected, label) = if in_maestri() {
                (WebTarget::Maestri, "Maestri Portal")
            } else if in_orca() {
                (WebTarget::Orca, "Orca browser")
            } else {
                (WebTarget::Browser, "default browser")
            };
            if !matches!(detected, WebTarget::Browser)
                && !json_mode
                && io::stdin().is_terminal()
                && io::stdout().is_terminal()
            {
                loop {
                    eprint!("Detected {label}. Open in [1] {label} (default), [2] system browser, [3] cancel: ");
                    io::stderr().flush()?;
                    let mut answer = String::new();
                    if io::stdin().read_line(&mut answer)? == 0 {
                        return Ok(None);
                    }
                    match answer.trim().to_ascii_lowercase().as_str() {
                        "" | "1" => break detected,
                        "2" => break WebTarget::Browser,
                        "3" => return Ok(None),
                        _ => eprintln!("Choose 1, 2 or 3."),
                    }
                }
            } else {
                detected
            }
        }
        target => target,
    };
    if matches!(selected, WebTarget::Browser | WebTarget::Auto) {
        lifecycle::browser_open(runtime, token)?;
        return Ok(Some("browser"));
    }
    if matches!(selected, WebTarget::Orca) {
        open_orca(runtime, token, timeout).await?;
        return Ok(Some("orca"));
    }

    let url = format!("{}/#token={token}", runtime.endpoint.trim_end_matches('/'));
    let (mut command, destination, recovery) = match selected {
        WebTarget::Maestri => {
            if !in_maestri() {
                return Err(fail("maestri_unavailable", "Open from a Maestri terminal with MAESTRI_SOCKET and MAESTRI_TERMINAL_ID, or use --target browser", 3));
            }
            let executable = env_value("MAESTRI_CLI").unwrap_or_else(|| "maestri".into());
            let mut command = tokio::process::Command::new(executable);
            command
                .args(["portal", "create"])
                .arg(url)
                .arg(format!("Tucano Proxy - {}", runtime.session));
            (
                command,
                "maestri",
                "run maestri debug and check MAESTRI_CLI or PATH",
            )
        }
        _ => unreachable!("system browser was handled above"),
    };
    // App clients may echo URLs. Never forward output containing session credentials.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(timeout), command.status())
        .await
        .map_err(|_| fail("web_open_timeout", format!("{destination} did not respond in time; check its browser before retrying; {recovery}"), 6))?
        .with_context(|| format!("Could not launch {destination}; {recovery}"))?;
    if !status.success() {
        return Err(fail("web_open_failed", format!("{destination} could not open the authenticated UI; {recovery}, or use --target browser"), 6));
    }
    Ok(Some(destination))
}

async fn orca_request(
    executable: &std::ffi::OsStr,
    args: &[&str],
    timeout: u64,
) -> Result<serde_json::Value> {
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout), command.output())
        .await
        .map_err(|_| fail("web_open_timeout", "Orca did not respond in time; check its browser before retrying", 6))?
        .context("Could not launch Orca; check the selected CLI's status --json and the current workspace")?;
    if !output.status.success() {
        return Err(fail("web_open_failed", "Orca could not open or authenticate its browser; check the selected CLI's status --json and the current workspace", 6));
    }
    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("Orca returned an invalid JSON response")?;
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(fail(
            "web_open_failed",
            "Orca reported an unsuccessful browser operation",
            6,
        ));
    }
    Ok(response)
}

async fn open_orca(runtime: &Runtime, token: &str, timeout: u64) -> Result<()> {
    let executable = orca_executable();
    let endpoint = runtime.endpoint.trim_end_matches('/');
    // Orca can retain the creation URL after history.replaceState. Keep credentials
    // out of its tab metadata: authenticate inside the newly created, origin-checked page.
    let created = orca_request(
        &executable,
        &[
            "tab",
            "create",
            "--url",
            endpoint,
            "--worktree",
            "current",
            "--json",
        ],
        timeout,
    )
    .await?;
    let page = created["result"]["browserPageId"]
        .as_str()
        .context("Orca did not return the created browser page ID")?;
    orca_request(
        &executable,
        &["wait", "--page", page, "--url", endpoint, "--json"],
        timeout,
    )
    .await?;
    let origin = serde_json::to_string(endpoint)?;
    let credential = serde_json::to_string(token)?;
    let expression = format!(
        r#"(async () => {{
        if (location.origin !== {origin}) throw new Error("Unexpected Tucano origin");
        const response = await fetch("/api/v1/auth", {{
            method: "POST", credentials: "same-origin",
            headers: {{ "Content-Type": "application/json" }},
            body: JSON.stringify({{ token: {credential} }})
        }});
        if (!response.ok) throw new Error("Tucano authentication failed");
        return true;
    }})()"#
    );
    orca_request(
        &executable,
        &[
            "eval",
            "--page",
            page,
            "--expression",
            &expression,
            "--json",
        ],
        timeout,
    )
    .await?;
    orca_request(&executable, &["reload", "--page", page, "--json"], timeout).await?;
    Ok(())
}
