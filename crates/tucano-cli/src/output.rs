use crate::client::fail;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    path::Path,
};

pub fn clean(text: &str) -> String {
    use std::fmt::Write as _;
    let mut safe = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            let _ = write!(safe, "{}", ch.escape_default());
        } else {
            safe.push(ch);
        }
    }
    safe
}
pub fn emit(value: Value, json_mode: bool, color: bool) -> Result<()> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if json_mode {
        serde_json::to_writer(&mut out, &json!({"apiVersion":1,"result":value}))?;
        writeln!(out)?;
        return Ok(());
    }
    if let Some(sessions) = value.get("sessions").and_then(Value::as_array) {
        if color {
            write!(out, "\x1b[1;35m")?;
        }
        writeln!(
            out,
            "{:<24} {:<24} {:<8} {:<8} {:<7} OS PROXY",
            "SESSION", "SERVICE", "PROXY", "CAPTURE", "FLOWS"
        )?;
        if color {
            write!(out, "\x1b[0m")?;
        }
        for item in sessions {
            let running = item["running"] == Value::Bool(true);
            let flag = |key: &str, yes: &'static str, no: &'static str| match item.get(key) {
                Some(Value::Bool(true)) => yes.to_string(),
                Some(Value::Bool(false)) => no.to_string(),
                _ => "-".to_string(),
            };
            let number = |key: &str| {
                item.get(key)
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".into())
            };
            let mut proxy = number("proxyPort");
            if item["proxyPortConflict"] == Value::Bool(true) {
                proxy.push_str(" !");
            }
            writeln!(
                out,
                "{:<24} {:<24} {:<8} {:<8} {:<7} {}",
                clean(item["session"].as_str().unwrap_or("-")),
                if running {
                    clean(item["endpoint"].as_str().unwrap_or("-"))
                } else {
                    "stopped".into()
                },
                proxy,
                flag("capturing", "on", "off"),
                number("flowsCount"),
                flag("systemProxyOn", "on", "off"),
            )?;
        }
        writeln!(out, "Selected session: {}", value["selected"])?;
        if sessions
            .iter()
            .any(|item| item["proxyPortConflict"] == Value::Bool(true))
        {
            writeln!(
                out,
                "! Two services claim the same proxy port; only one holds the listener. Stop one, or start it with an explicit --proxy-port."
            )?;
        }
        return Ok(());
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        if color {
            write!(out, "\x1b[1;35m")?;
        }
        writeln!(
            out,
            "{:<36} {:<8} {:<7} {:<28} PATH",
            "ID", "METHOD", "STATUS", "HOST"
        )?;
        if color {
            write!(out, "\x1b[0m")?;
        }
        for item in items {
            let string = |key: &str| -> String {
                item.get(key)
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_str().map(clean).unwrap_or_else(|| v.to_string()))
                    .unwrap_or_else(|| "-".into())
            };
            writeln!(
                out,
                "{:<36} {:<8} {:<7} {:<28} {}",
                string("id"),
                string("method"),
                string("status"),
                string("host"),
                string("path")
            )?;
        }
        writeln!(
            out,
            "{} matching flows; next offset: {}",
            value["total"], value["nextOffset"]
        )?;
    } else if let Some(text) = value.as_str() {
        for line in text.split('\n') {
            writeln!(out, "{}", clean(line))?;
        }
    } else if value.is_null() {
        writeln!(out, "OK")?;
    } else {
        for line in serde_json::to_string_pretty(&value)?.lines() {
            writeln!(out, "{}", clean(line))?;
        }
    }
    Ok(())
}

/// Copyable examples retain session and custom storage, including paths with spaces.
pub fn cli_command(root: &Path, session: &str, args: &[&str]) -> String {
    fn quote(value: &str) -> String {
        if cfg!(windows) {
            format!("'{}'", value.replace('\'', "''"))
        } else if !value.is_empty()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./:-".contains(&b))
        {
            value.to_owned()
        } else {
            format!("'{}'", value.replace('\'', "'\"'\"'"))
        }
    }
    let executable = std::env::args_os()
        .next()
        .unwrap_or_else(|| "tucano-proxy".into());
    let mut command = if cfg!(windows) {
        format!("& {}", quote(&executable.to_string_lossy()))
    } else {
        quote(&executable.to_string_lossy())
    };
    if crate::lifecycle::data_root(None).ok().as_deref() != Some(root) {
        command.push_str(" --data-dir ");
        command.push_str(&quote(&root.to_string_lossy()));
    }
    command.push_str(" --session=");
    command.push_str(&quote(session));
    for arg in args {
        command.push(' ');
        command.push_str(&quote(arg));
    }
    command
}

pub fn service_ready(
    runtime: &crate::client::Runtime,
    state: &Value,
    root: &Path,
    color: bool,
) -> Result<()> {
    let mut out = io::stdout().lock();
    if color {
        write!(out, "\x1b[1;35m")?;
    }
    writeln!(out, "Tucano Proxy {} — ready", env!("CARGO_PKG_VERSION"))?;
    if color {
        write!(out, "\x1b[0m")?;
    }
    writeln!(out, "  Session   {}", clean(&runtime.session))?;
    writeln!(
        out,
        "  Capture   {}",
        if state["running"] == true {
            "running"
        } else {
            "stopped"
        }
    )?;
    writeln!(out, "  Proxy     127.0.0.1:{}", state["port"])?;
    writeln!(out, "  Web/API   {}", clean(&runtime.endpoint))?;
    writeln!(
        out,
        "  Routing   {}",
        if state["systemProxyOn"] == true {
            "system proxy enabled"
        } else {
            "configure your application to use this proxy"
        }
    )?;
    if state["caInstalled"] != true {
        writeln!(
            out,
            "  HTTPS     trust not verified; use setup for certificate guidance"
        )?;
    }
    writeln!(
        out,
        "\n  Inspect   {}",
        clean(&cli_command(root, &runtime.session, &["tui"]))
    )?;
    writeln!(
        out,
        "  Web       {}",
        clean(&cli_command(root, &runtime.session, &["web", "--open"]))
    )?;
    writeln!(
        out,
        "  Stop      {}",
        clean(&cli_command(root, &runtime.session, &["stop"]))
    )?;
    Ok(())
}
pub fn confirm(yes: bool, operation: &str) -> Result<()> {
    if yes {
        Ok(())
    } else {
        Err(fail(
            "confirmation_required",
            format!("{operation} requires explicit --yes; no interactive prompt will be shown"),
            7,
        ))
    }
}
pub fn write_bytes(path: &Path, bytes: &[u8], overwrite: bool) -> Result<Value> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(fail(
                "unsafe_output",
                "Output must be a regular, non-symlink file",
                5,
            ));
        }
        if !overwrite {
            return Err(fail(
                "confirmation_required",
                format!("{} already exists; pass --yes to overwrite", path.display()),
                7,
            ));
        }
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("Cannot create {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(json!({"path":path,"bytes":bytes.len()}))
}
