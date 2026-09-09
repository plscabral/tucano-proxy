use crate::{
    args::WebTarget,
    client::{fail, Client, Runtime},
    lifecycle,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, IsTerminal, Read, Write},
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
};
use tucano_core::ca::CertAuthority;

#[path = "setup_ui.rs"]
mod ui;

const MARKER: &str = "setup.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion {
    schema_version: u32,
    session: String,
    ca_fingerprint: String,
    completed: bool,
    proxy_port: u16,
    api_port: u16,
    interface: String,
}

fn inspect_directories(root: &Path, session: &str) -> Result<PathBuf> {
    let directory = tucano_service::session_path(root, session)?;
    for path in [
        root.to_path_buf(),
        root.join("sessions"),
        directory.clone(),
        directory.join("ca"),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    bail!("Expected a real, non-symlink directory: {}", path.display());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.uid() != unsafe { libc::geteuid() } {
                        bail!("Directory is owned by another user: {}", path.display());
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("Cannot inspect {}", path.display()))
            }
        }
    }
    Ok(directory)
}

fn existing_ca(root: &Path, session: &str) -> Result<Option<CertAuthority>> {
    let directory = inspect_directories(root, session)?;
    CertAuthority::load_existing(&directory).map_err(|error| anyhow::anyhow!(
        "Cannot use this session's CA: {error}. Restore its matching certificate/key from backup or choose a new --session; no files were changed."
    ))
}

fn read_completion(
    directory: &Path,
    session: &str,
    fingerprint: &str,
) -> Result<Option<Completion>> {
    let path = directory.join(MARKER);
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Cannot safely read setup completion marker"),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || fs::symlink_metadata(&path)?.file_type().is_symlink()
        || metadata.len() > 16_384
    {
        bail!("Setup marker must be a regular, non-symlink file of at most 16 KiB");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            bail!("Setup marker must be owned by the current user with owner-only permissions");
        }
    }
    let marker: Completion = serde_json::from_reader(file.take(16_385)).context(
        "Malformed setup marker; rerun setup to replace it only after successful configuration",
    )?;
    let valid = marker.schema_version == 1
        && marker.completed
        && marker.session == session
        && marker.ca_fingerprint == fingerprint
        && marker.api_port > 0
        && marker.proxy_port != marker.api_port
        && matches!(marker.interface.as_str(), "cli" | "tui" | "web");
    Ok(valid.then_some(marker))
}

pub fn is_complete(root: &Path, session: &str) -> bool {
    let Ok(Some(ca)) = existing_ca(root, session) else {
        return false;
    };
    let Ok(fingerprint) = ca.fingerprint() else {
        return false;
    };
    tucano_service::session_path(root, session)
        .ok()
        .and_then(|directory| {
            read_completion(&directory, session, &fingerprint)
                .ok()
                .map(|marker| marker.is_some())
        })
        .unwrap_or(false)
}

pub fn resolve_ports(
    root: &Path,
    session: &str,
    proxy: Option<u16>,
    web: Option<u16>,
) -> Result<(u16, u16)> {
    if let (Some(proxy), Some(web)) = (proxy, web) {
        return Ok((proxy, web));
    }
    let saved = match existing_ca(root, session)? {
        Some(ca) => {
            let fingerprint = ca
                .fingerprint()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            read_completion(
                &tucano_service::session_path(root, session)?,
                session,
                &fingerprint,
            )?
        }
        None => None,
    };
    Ok((
        proxy
            .or_else(|| saved.as_ref().map(|m| m.proxy_port))
            .unwrap_or(8888),
        web.or_else(|| saved.as_ref().map(|m| m.api_port))
            .unwrap_or(7777),
    ))
}

/// Read-only inspection: never instantiate AppState or call load_or_create.
pub async fn status(root: &Path, session: &str) -> Result<Value> {
    let directory = tucano_service::session_path(root, session)?;
    let mut value = json!({
        "session":session, "dataDirectory":root, "sessionDirectory":directory,
        "complete":false, "markerPath":directory.join(MARKER),
        "ca":{"state":"missing", "path":directory.join("ca/tucano-root.pem"), "trust":"not_applicable"},
        "guidance":"Trust belongs to this exact session certificate. A desktop or another session's Tucano CA does not establish trust for this session; those data directories were not inspected."
    });
    match existing_ca(root, session) {
        Ok(Some(ca)) => {
            let fingerprint = ca
                .fingerprint()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            value["ca"]["state"] = json!("existing");
            value["ca"]["fingerprint"] = json!(fingerprint);
            match ca.system_trust() {
                Ok(Some(true)) => value["ca"]["trust"] = json!("trusted"),
                Ok(Some(false)) => value["ca"]["trust"] = json!("untrusted"),
                Ok(None) => value["ca"]["trust"] = json!("unsupported"),
                Err(error) => {
                    value["ca"]["trust"] = json!("unknown");
                    value["ca"]["trustError"] = json!(error.to_string());
                }
            }
            match read_completion(&directory, session, &fingerprint) {
                Ok(marker) => value["complete"] = json!(marker.is_some()),
                Err(error) => value["markerError"] = json!(format!("{error:#}")),
            }
        }
        Ok(None) => {}
        Err(error) => {
            value["ca"]["state"] = json!("damaged");
            value["ca"]["error"] = json!(format!("{error:#}"));
        }
    }
    match lifecycle::connect(root, session, 2).await {
        Ok((runtime, _)) => value["service"] = lifecycle::summary(&runtime),
        Err(error) => {
            let unavailable = error
                .downcast_ref::<crate::client::Failure>()
                .is_some_and(|error| error.exit == 3);
            value["service"] = json!({"running":false,"state":if unavailable {"stopped"} else {"unknown"},"detail":error.to_string()});
        }
    }
    Ok(value)
}

pub fn print_status(value: &Value) -> Result<()> {
    let text = |key: &str| value[key].as_str().unwrap_or("unknown");
    let mut out = io::stdout().lock();
    writeln!(out, "Tucano Proxy setup — session {}", text("session"))?;
    writeln!(
        out,
        "  Setup: {}",
        if value["complete"] == true {
            "complete"
        } else {
            "not complete; run setup in an interactive terminal"
        }
    )?;
    writeln!(out, "  Session: {}", text("sessionDirectory"))?;
    writeln!(
        out,
        "  CA: {}",
        value["ca"]["state"].as_str().unwrap_or("unknown")
    )?;
    writeln!(
        out,
        "  Certificate: {}",
        value["ca"]["path"].as_str().unwrap_or("unknown")
    )?;
    if let Some(fingerprint) = value["ca"]["fingerprint"].as_str() {
        writeln!(out, "  Exact certificate SHA-1 identifier: {fingerprint}")?;
    }
    writeln!(
        out,
        "  OS trust for this CA: {}",
        value["ca"]["trust"].as_str().unwrap_or("unknown")
    )?;
    for error in [
        &value["ca"]["error"],
        &value["ca"]["trustError"],
        &value["markerError"],
    ] {
        if let Some(error) = error.as_str() {
            writeln!(out, "  Attention: {error}")?;
        }
    }
    if value["service"]["running"] == true {
        writeln!(
            out,
            "  Service: {} (proxy port {})",
            value["service"]["endpoint"].as_str().unwrap_or("unknown"),
            value["service"]["proxyPort"]
        )?;
    } else {
        writeln!(
            out,
            "  Service: {}",
            value["service"]["state"].as_str().unwrap_or("unknown")
        )?;
        if value["service"]["state"] == "unknown" {
            writeln!(
                out,
                "  Attention: {}",
                value["service"]["detail"]
                    .as_str()
                    .unwrap_or("Cannot verify service")
            )?;
        }
    }
    writeln!(out, "  {}", text("guidance"))?;
    if value["ca"]["trust"] == "unsupported" {
        writeln!(out, "  Export the public PEM with ca export, or use the certificate path above. Install it with your OS/application trust tooling; never share the private key or disable TLS verification.")?;
    }
    Ok(())
}

fn available_port(preferred: u16, excluded: Option<u16>) -> Result<u16> {
    for port in preferred..=preferred.saturating_add(99) {
        if Some(port) != excluded && TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok() {
            return Ok(port);
        }
    }
    bail!("No free local port in {preferred}–{}. Stop an unused service or run start with explicit --proxy-port/--web-port, then rerun setup.", preferred.saturating_add(99))
}

fn save_completion(root: &Path, session: &str, completion: &Completion) -> Result<()> {
    let directory = inspect_directories(root, session)?;
    // Reuse the service's owner-only directory/ACL convention; this is only called on completion.
    tucano_service::create_session(root, session)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(&mut temporary, completion)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(directory.join(MARKER))
        .map_err(|error| error.error)?;
    Ok(())
}

async fn configure(
    root: &Path,
    session: &str,
    timeout: u64,
    active: &mut Option<Runtime>,
    ui: &mut ui::Wizard,
) -> Result<(Runtime, Client, Completion)> {
    let directory = tucano_service::session_path(root, session)?;
    ui.step(
        0,
        format!(
            "Session: {session}\nData directory: {}",
            directory.display()
        ),
    );
    let before = existing_ca(root, session)?;
    let pair = match ui
        .wait(lifecycle::connect(root, session, timeout.min(2)))
        .await
    {
        Ok(pair) => pair,
        Err(error)
            if error
                .downcast_ref::<crate::client::Failure>()
                .is_some_and(|error| error.exit == 3) =>
        {
            let mut proxy = available_port(8888, None)?;
            let mut api = available_port(7777, Some(proxy))?;
            let ports = format!("Proxy {proxy}  /  Web {api}");
            if ui
                .choose(
                    "Choose your local ports",
                    "Use the suggested ports, or choose your own.",
                    &[
                        ("Use suggested ports", &ports),
                        (
                            "Choose ports manually",
                            "For an existing development environment",
                        ),
                    ],
                )
                .await?
                == 1
            {
                proxy = ui.port("Proxy port", proxy, None).await?;
                api = ui.port("Web inspector port", api, Some(proxy)).await?;
            }
            ui.busy(
                "Starting your local workspace",
                "Capture is off. System proxy settings stay unchanged.",
            )?;
            ui.wait(lifecycle::ensure(
                root,
                session,
                timeout,
                Some(api),
                Some(proxy),
                false,
                false,
            ))
            .await?
        }
        Err(error) => return Err(error),
    };
    let (runtime, client) = pair;
    *active = Some(runtime.clone());
    let ca = existing_ca(root, session)?.context("Service did not create session CA material")?;
    let fingerprint = ca
        .fingerprint()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if let Some(before) = before {
        if before
            .fingerprint()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            != fingerprint
        {
            bail!("Session CA changed during setup; refusing further changes. Inspect the session before retrying.");
        }
    }
    ui.step(1, format!("Certificate: {}\nSHA-1 identifier: {fingerprint}\nTrust applies to this exact session certificate.\nNever share its private key.", ca.cert_path.display()));
    ui.busy(
        "Checking certificate trust",
        "Only this session's certificate is checked.",
    )?;
    match ca.system_trust() {
        Ok(Some(true)) => {}
        trust => {
            let hint = match trust {
                Ok(Some(false)) => "This session's certificate is not trusted by your system.",
                Ok(None) => "This platform needs manual certificate installation.",
                Err(error) => {
                    ui.detail(&format!("Trust check error: {error}"));
                    "System trust could not be verified. Press d for details."
                }
                _ => unreachable!(),
            };
            if cfg!(any(target_os = "macos", target_os = "windows")) {
                let install = ui
                    .choose(
                        "Enable HTTPS inspection?",
                        hint,
                        &[
                            ("Not now", "Continue without changing system trust"),
                            (
                                "Install this session's certificate",
                                "Changes OS trust; may require administrator approval",
                            ),
                        ],
                    )
                    .await?
                    == 1;
                if install {
                    ui.busy(
                        "Waiting for system approval",
                        "Approve the certificate installation in the system dialog.",
                    )?;
                    ui.wait(client.invoke("install_ca", json!({}))).await?;
                    match ca.system_trust() {
                        Ok(Some(true)) => {}
                        Ok(_) => bail!("Installation returned, but this CA is not verified as trusted. Check OS trust settings and rerun setup; completion was not recorded."),
                        Err(error) => bail!("Cannot verify trust after installation: {error}. Check OS trust settings and rerun setup."),
                    }
                }
            } else {
                ui.choose(
                    "Configure HTTPS trust manually",
                    hint,
                    &[(
                        "Continue without installing",
                        "Press d for the public certificate path",
                    )],
                )
                .await?;
            }
        }
    }
    ui.step(2, format!("HTTP proxy: 127.0.0.1:{}\nWeb inspector: {}\nApplications must explicitly use the proxy.\nSetup never changes OS proxy settings.", runtime.proxy_port, runtime.endpoint));
    let state = ui.wait(client.invoke("get_status", json!({}))).await?;
    let proxy_port = state["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .context("Service returned an invalid proxy port")?;
    if state["running"] != true
        && ui
            .choose(
                "Start capturing traffic?",
                "Point your application at this proxy when you are ready.",
                &[
                    ("Keep capture off", "Start it later with capture start"),
                    (
                        "Start local capture",
                        "System proxy settings stay unchanged",
                    ),
                ],
            )
            .await?
            == 1
    {
        if state["systemProxyOn"] == true {
            bail!("Session reports an existing OS proxy setting. Resolve it explicitly with the CLI before starting capture; setup will not change OS proxy settings.");
        }
        ui.busy(
            "Starting capture",
            &format!("Listening on 127.0.0.1:{proxy_port}"),
        )?;
        ui.wait(client.invoke("start_proxy", json!({"port":proxy_port})))
            .await?;
    }
    ui.step(3, format!("Session: {session}\nProxy: 127.0.0.1:{proxy_port}\nWeb: {}\nData directory: {}\nClosing an inspector does not stop the service.", runtime.endpoint, directory.display()));
    let interface = match ui
        .choose(
            "Where would you like to work?",
            "Terminal and web share this session's captures.",
            &[
                ("Stay in the CLI", "Finish setup and return to your shell"),
                (
                    "Open terminal inspector",
                    "Keyboard-first capture and inspection",
                ),
                (
                    "Open web inspector",
                    "Authenticated browser, Maestri or Orca",
                ),
            ],
        )
        .await?
    {
        1 => "tui",
        2 => "web",
        _ => "cli",
    };
    let api_port = reqwest::Url::parse(&runtime.endpoint)?
        .port_or_known_default()
        .context("Missing API port")?;
    let completion = Completion {
        schema_version: 1,
        session: session.into(),
        ca_fingerprint: fingerprint,
        completed: true,
        proxy_port,
        api_port,
        interface: interface.into(),
    };
    ui.finish(
        "Your workspace is ready",
        "Existing captures and certificates have been preserved.",
    )?;
    Ok((runtime, client, completion))
}

pub async fn run(root: &Path, session: &str, timeout: u64, color: bool) -> Result<Value> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(fail("terminal_required", "Setup requires interactive stdin and stdout. Use setup --status for read-only inspection.", 2));
    }
    let mut ui = ui::Wizard::new(session, color)?;
    let mut active = None;
    let result = tokio::select! {
        result = configure(root, session, timeout, &mut active, &mut ui) => result,
        signal = tokio::signal::ctrl_c() => {
            signal.context("Cannot listen for cancellation")?;
            Err(fail("setup_cancelled", "Setup cancelled; rerun setup to finish", 2))
        }
    };
    drop(ui);
    let result = match result {
        Ok((runtime, client, completion)) => async {
            match completion.interface.as_str() {
                "tui" => crate::tui::run(client, "auto", Some(color)).await?,
                "web" => {
                    crate::web::open(&runtime, &runtime.token, WebTarget::Auto, false, timeout).await?
                        .ok_or_else(|| fail("setup_cancelled", "Web opening cancelled; rerun setup to finish", 2))?;
                }
                _ => {}
            }
            save_completion(root, session, &completion)?;
            println!("\n  Setup complete. Next launch opens the terminal inspector.");
            Ok(json!({"complete":true,"session":session,"interface":completion.interface,"service":lifecycle::summary(&runtime)}))
        }.await,
        Err(error) => Err(error),
    };
    if active.is_some() {
        println!(
            "  Stop session: {}",
            crate::output::clean(&crate::output::cli_command(root, session, &["stop"]))
        );
    } else if result.is_err() {
        println!(
            "  Check session: {}",
            crate::output::clean(&crate::output::cli_command(root, session, &["status"]))
        );
    }
    result
}
