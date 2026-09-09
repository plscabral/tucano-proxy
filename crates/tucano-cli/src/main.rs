mod args;
pub mod client;
mod lifecycle;
mod output;
mod setup;
mod skills;
pub mod tui;
mod update;
mod web;

use anyhow::{Context, Result};
use args::*;
use clap::{CommandFactory, Parser};
use client::{fail, Client, Failure};
use serde_json::{json, Value};
use std::{
    io::{self, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[tokio::main]
async fn main() {
    let json_mode = std::env::args_os().any(|arg| arg == "--json");
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                let _ = error.print();
                return;
            }
            if json_mode {
                let _ = writeln!(
                    io::stdout(),
                    "{}",
                    json!({"apiVersion":1,"error":{"code":"usage","message":error.to_string()}})
                );
            } else {
                let _ = error.print();
            }
            std::process::exit(2);
        }
    };
    let json_mode = cli.json;
    let color = !json_mode
        && match cli.color {
            Color::Always => true,
            Color::Never => false,
            Color::Auto => {
                io::stdout().is_terminal()
                    && std::env::var_os("NO_COLOR").is_none()
                    && std::env::var("TERM").as_deref() != Ok("dumb")
            }
        };
    let result = run(cli, color).await.and_then(|value| match value {
        Some(value) => output::emit(value, json_mode, color),
        None => Ok(()),
    });
    if let Err(error) = result {
        if error
            .downcast_ref::<io::Error>()
            .is_some_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
        {
            return;
        }
        let (code, exit) = if let Some(error) = error.downcast_ref::<Failure>() {
            (error.code, error.exit)
        } else if error.downcast_ref::<io::Error>().is_some() {
            ("io_error", 5)
        } else {
            ("operation_failed", 6)
        };
        if json_mode {
            let _ = writeln!(
                io::stdout(),
                "{}",
                json!({"apiVersion":1,"error":{"code":code,"message":format!("{error:#}")}})
            );
        } else {
            eprintln!("Error [{code}]: {}", output::clean(&format!("{error:#}")));
        }
        std::process::exit(exit);
    }
}
async fn run(cli: Cli, color: bool) -> Result<Option<Value>> {
    let root = lifecycle::data_root(cli.data_dir.as_ref())?;
    tucano_service::session_path(&root, &cli.session)?;
    let command = match cli.command {
        Some(command) => command,
        None if io::stdin().is_terminal() && io::stdout().is_terminal() && !cli.json => {
            if setup::is_complete(&root, &cli.session) {
                Command::Tui { theme: Theme::Auto }
            } else {
                Command::Setup { status: false }
            }
        }
        None => {
            if cli.json {
                return Ok(Some(
                    json!({"help":Cli::command().render_long_help().to_string()}),
                ));
            }
            Cli::command().print_long_help()?;
            println!();
            return Ok(None);
        }
    };
    let value = match command {
        Command::Setup { status } => {
            if status {
                let value = setup::status(&root, &cli.session).await?;
                if cli.json {
                    return Ok(Some(value));
                }
                setup::print_status(&value, color)?;
            } else {
                if cli.json {
                    return Err(fail("terminal_required", "The setup wizard is interactive. Use setup --status --json for read-only inspection.", 2));
                }
                setup::run(&root, &cli.session, cli.timeout, color).await?;
            }
            return Ok(None);
        }
        Command::Update { check, yes } => {
            let value = update::run(check, yes, cli.json, cli.timeout).await?;
            return Ok(cli.json.then_some(value));
        }
        Command::Start(start) => {
            if start.system_proxy {
                output::confirm(start.yes, "Changing the OS system proxy")?;
            }
            if start.foreground {
                let (proxy_port, api_port) =
                    setup::resolve_ports(&root, &cli.session, start.proxy_port, start.web_port)?;
                lifecycle::foreground(
                    tucano_service::ServeOptions {
                        data_dir: root,
                        session: cli.session,
                        api_port,
                        proxy_port,
                        capture: true,
                        system_proxy: start.system_proxy,
                    },
                    cli.timeout,
                    start.open,
                )
                .await?
            } else {
                let (runtime, client) = lifecycle::ensure(
                    &root,
                    &cli.session,
                    cli.timeout,
                    start.web_port,
                    start.proxy_port,
                    true,
                    start.system_proxy,
                )
                .await?;
                if start.open {
                    lifecycle::browser_open(&runtime, &client.token)?;
                }
                if !cli.json {
                    let state = client.invoke("get_status", json!({})).await?;
                    output::service_ready(&runtime, &state, &root, color)?;
                    return Ok(None);
                }
                lifecycle::summary(&runtime)
            }
        }
        Command::Serve {
            proxy_port,
            web_port,
            no_capture,
            system_proxy,
            yes,
        } => {
            if system_proxy {
                output::confirm(yes, "Changing the OS system proxy")?;
            }
            let (proxy_port, api_port) =
                setup::resolve_ports(&root, &cli.session, proxy_port, web_port)?;
            lifecycle::foreground(
                tucano_service::ServeOptions {
                    data_dir: root,
                    session: cli.session,
                    api_port,
                    proxy_port,
                    capture: !no_capture,
                    system_proxy,
                },
                cli.timeout,
                false,
            )
            .await?
        }
        Command::Web { port, open, target } => {
            let (runtime, client) =
                lifecycle::ensure(&root, &cli.session, cli.timeout, port, None, false, false)
                    .await?;
            if open {
                let destination =
                    web::open(&runtime, &client.token, target, cli.json, cli.timeout).await?;
                if !cli.json {
                    match destination {
                        Some("maestri") => println!("Opened in Maestri Portal."),
                        Some("orca") => println!("Opened in the Orca browser."),
                        Some(_) => println!("Opened in the default browser."),
                        None => println!("Opening cancelled. The session remains running."),
                    }
                    return Ok(None);
                }
                let mut summary = lifecycle::summary(&runtime);
                summary["openedIn"] = json!(destination);
                return Ok(Some(summary));
            }
            if !cli.json {
                let state = client.invoke("get_status", json!({})).await?;
                output::service_ready(&runtime, &state, &root, color)?;
                return Ok(None);
            }
            lifecycle::summary(&runtime)
        }
        Command::Tui { theme } => {
            if cli.json || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                return Err(fail("terminal_required","TUI requires interactive stdin/stdout without --json; use flows list --json for automation",2));
            }
            let (_, client) =
                lifecycle::ensure(&root, &cli.session, cli.timeout, None, None, false, false)
                    .await?;
            let terminal_color = match cli.color {
                Color::Auto => None,
                Color::Always => Some(true),
                Color::Never => Some(false),
            };
            tui::run(client, theme.as_str(), terminal_color).await?;
            return Ok(None);
        }
        Command::Status => match lifecycle::connect(&root, &cli.session, cli.timeout).await {
            Ok((runtime, client)) => {
                json!({"service":lifecycle::summary(&runtime),"capture":client.invoke("get_status",json!({})).await?,"stats":client.invoke("get_stats",json!({})).await?})
            }
            Err(error) if client::unavailable(&error) => {
                json!({"service":{"running":false,"session":cli.session},"detail":error.to_string()})
            }
            Err(error) => return Err(error),
        },
        Command::Stop { all } => {
            if all {
                lifecycle::stop_all(&root, cli.timeout).await?
            } else {
                lifecycle::stop(&root, &cli.session, cli.timeout).await?
            }
        }
        Command::McpStdio => {
            if cli.json {
                return Err(fail(
                    "usage",
                    "mcp-stdio owns stdout for the MCP protocol; do not combine it with --json",
                    2,
                ));
            }
            tokio::task::spawn_blocking(move || {
                tucano_core::mcp_stdio::run_for_session(root, cli.session)
            })
            .await?
            .map_err(|error| fail("mcp_configuration", error.to_string(), 5))?;
            return Ok(None);
        }
        Command::Doctor => doctor(&root, &cli.session, cli.timeout).await?,
        Command::Completions { shell } => {
            let mut script = Vec::new();
            clap_complete::generate(shell, &mut Cli::command(), "tucano-proxy", &mut script);
            if cli.json {
                Value::String(String::from_utf8(script)?)
            } else {
                io::stdout().write_all(&script)?;
                return Ok(None);
            }
        }
        Command::Skill(command) => skills::run(command)?,
        Command::Session(Session::List) => {
            let mut items = Vec::new();
            for session in tucano_service::list_sessions(&root)? {
                items.push(
                    match lifecycle::connect(&root, &session, cli.timeout.min(2)).await {
                        Ok((runtime, client)) => {
                            let mut item = lifecycle::summary(&runtime);
                            // A reachable service always answers get_status; keep the
                            // row instead of hiding a running session behind an error.
                            match client.invoke("get_status", json!({})).await {
                                Ok(status) => {
                                    for key in
                                        ["running", "port", "systemProxyOn", "flowsCount"]
                                    {
                                        if let Some(value) = status.get(key) {
                                            let name = match key {
                                                "running" => "capturing",
                                                "port" => "capturePort",
                                                other => other,
                                            };
                                            item[name] = value.clone();
                                        }
                                    }
                                }
                                Err(error) => {
                                    item["detail"] = json!(output::clean(&error.to_string()))
                                }
                            }
                            item
                        }
                        Err(error) if client::unavailable(&error) => {
                            json!({"session":session,"running":false})
                        }
                        Err(error) => {
                            json!({"session":session,"running":false,"detail":output::clean(&error.to_string())})
                        }
                    },
                );
            }
            lifecycle::annotate_port_conflicts(&mut items);
            json!({"sessions":items,"selected":cli.session})
        }
        Command::Session(Session::Create { name }) => {
            json!({"session":name,"path":tucano_service::create_session(&root,&name)?})
        }
        Command::Session(Session::Delete { name, yes }) => {
            output::confirm(yes, "Permanently deleting a session")?;
            tucano_service::delete_session(&root, &name)?;
            json!({"session":name,"deleted":true})
        }
        Command::Auth(Auth::Show { scope }) => {
            let (runtime, client) = lifecycle::connect(&root, &cli.session, cli.timeout).await?;
            // An explicitly supplied read credential must not be upgraded to local admin by this command.
            if std::env::var_os("TUCANO_TOKEN").is_some() {
                let identity = client.verify(&runtime).await?;
                if matches!(scope, Scope::Admin) && identity["scope"] != "admin" {
                    return Err(fail(
                        "authentication_failed",
                        "Read credential cannot reveal administrative credentials",
                        4,
                    ));
                }
            }
            json!({"session":runtime.session,"endpoint":runtime.endpoint,"scope":scope.as_str(),"token":if matches!(scope,Scope::Admin) { runtime.token } else { runtime.read_token }})
        }
        command => {
            let (_, client) = lifecycle::connect(&root, &cli.session, cli.timeout).await?;
            connected(command, &client).await?
        }
    };
    Ok(Some(value))
}
fn headers(values: Vec<String>) -> Result<Vec<(String, String)>> {
    values
        .into_iter()
        .map(|value| {
            let (name, value) = value
                .split_once(':')
                .context("Headers must use 'Name: value' syntax")?;
            if name.trim().is_empty()
                || name.chars().any(|c| c.is_control())
                || value.chars().any(|c| c.is_control() && c != '\t')
            {
                return Err(fail("usage", "Invalid HTTP header", 2));
            }
            Ok((name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect()
}
fn body(body: Option<String>, file: Option<PathBuf>) -> Result<Option<String>> {
    match file {
        Some(path) if path == Path::new("-") => {
            if io::stdin().is_terminal() {
                return Err(fail(
                    "usage",
                    "--body-file - requires piped stdin (will not prompt interactively)",
                    2,
                ));
            }
            let mut value = String::new();
            io::stdin().read_to_string(&mut value)?;
            Ok(Some(value))
        }
        Some(path) => Ok(Some(
            std::fs::read_to_string(path).context("Cannot read UTF-8 request body")?,
        )),
        None => Ok(body),
    }
}
async fn connected(command: Command, client: &Client) -> Result<Value> {
    match command {
        Command::Flows(command) => match command {
            Flows::List { filter,offset,limit,sort,descending } => client.invoke("query_flows",json!({"filter":filter,"offset":offset,"limit":limit,"sort":sort,"descending":descending})).await,
            Flows::Get { id } => { let value = client.invoke("get_flow",json!({"id":id})).await?; if value.is_null() { Err(fail("not_found","Flow not found",6)) } else { Ok(value) } },
            Flows::Delete { ids,yes } => { output::confirm(yes,"Deleting flows")?; client.invoke("delete_flows",json!({"ids":ids})).await },
            Flows::Clear { yes } => { output::confirm(yes,"Clearing all retained flows")?; client.invoke("clear_flows",json!({})).await },
            Flows::Note { id,note,clear:_ } => client.invoke("update_flow_note",json!({"id":id,"note":note})).await,
            Flows::Mark { id,mark,clear:_ } => client.invoke("update_flow_mark",json!({"id":id,"mark":mark})).await,
        },
        Command::Capture(command) => match command {
            Capture::Start { port,system_proxy,yes } => {
                if system_proxy { output::confirm(yes,"Changing the OS system proxy")?; }
                let port = match port {
                    Some(port) => port,
                    None => client.invoke("get_status", json!({})).await?["port"].as_u64()
                        .and_then(|port| u16::try_from(port).ok()).context("Service returned an invalid proxy port")?,
                };
                client.invoke(if system_proxy { "start_capture" } else { "start_proxy" },json!({"port":port})).await
            },
            Capture::Stop => client.invoke("stop_capture",json!({})).await,
        },
        Command::Compose { url,method,headers:values,body:value,body_file,no_log } => {
            let parsed = reqwest::Url::parse(&url).map_err(|e|fail("usage",format!("Invalid request URL: {e}"),2))?;
            if !matches!(parsed.scheme(),"http"|"https") || parsed.host_str().is_none() { return Err(fail("usage","Compose requires an absolute http:// or https:// URL",2)); }
            client.invoke("compose_request",json!({"url":url,"method":method,"headers":headers(values)?,"body":body(value,body_file)?,"log":!no_log})).await
        },
        Command::Replay { id,headers:values,body:value,body_file } => {
            let replacement_headers = if values.is_empty() { None } else { Some(headers(values)?) };
            client.invoke("replay_flow",json!({"id":id,"headers":replacement_headers,"body":body(value,body_file)?})).await
        },
        Command::Export { format,ids,output,yes } => {
            let text = client.invoke("export_flows",json!({"format":format.as_str(),"ids":if ids.is_empty() { None } else { Some(ids) }})).await?;
            match output { Some(path) => output::write_bytes(&path,text.as_str().context("Service export was not text")?.as_bytes(),yes), None => Ok(text) }
        },
        Command::Session(Session::Export { output,ids,yes }) => { let bytes = client.export_session(if ids.is_empty() { None } else { Some(&ids) }).await?; output::write_bytes(&output,&bytes,yes) },
        Command::Session(Session::Import { input,yes }) => { output::confirm(yes,"Replacing current session traffic")?; client.import_session(std::fs::read(input)?).await },
        Command::Ca(command) => match command {
            Ca::Status => { let status = client.invoke("get_status",json!({})).await?; Ok(json!({"installed":status["caInstalled"]})) },
            Ca::Export { output,yes } => { let cert = client.invoke("export_ca",json!({})).await?; match output { Some(path) => output::write_bytes(&path,cert.as_str().context("CA was not PEM text")?.as_bytes(),yes),None => Ok(cert) } },
            Ca::Install { yes } | Ca::Uninstall { yes } => {
                output::confirm(yes,"Changing OS certificate trust")?;
                if !io::stdin().is_terminal() { return Err(fail("terminal_required","OS trust changes may request authorization and require a terminal. For automation, export the CA and configure your application's trust explicitly.",2)); }
                client.invoke(if matches!(command,Ca::Install { .. }) { "install_ca" } else { "uninstall_ca" },json!({})).await
            },
        },
        Command::Ssl(command) => match command {
            Ssl::Get => client.invoke("get_ssl_settings",json!({})).await,
            Ssl::Set { mode,hosts,skip_hosts,insecure_hosts,yes } => {
                if !insecure_hosts.is_empty() { output::confirm(yes,"Allowing upstream TLS trust exceptions for development hosts")?; }
                let mut settings = client.invoke("get_ssl_settings",json!({})).await?;
                settings["mode"] = json!(mode);
                settings["hosts"] = json!(hosts);
                settings["skipHosts"] = json!(skip_hosts);
                settings["insecureHosts"] = json!(insecure_hosts);
                client.invoke("set_ssl_settings",json!({"settings":settings})).await
            },
        },
        Command::Privacy(command) => match command {
            Privacy::Get => client.invoke("get_private_mode",json!({})).await,
            Privacy::Set { enabled,yes } => { if enabled { output::confirm(yes,"Enabling privacy mode and erasing retained traffic")?; } client.invoke("set_private_mode",json!({"enabled":enabled})).await },
        },
        Command::Config(command) => match command {
            Config::Get => Ok(json!({"keepLimit":client.invoke("get_keep_limit",json!({})).await?})),
            Config::Set { keep_limit,yes } => { output::confirm(yes,"Changing retention limits (may trim retained flows)")?; client.invoke("set_keep_limit",json!({"limit":keep_limit})).await?; Ok(json!({"keepLimit":keep_limit})) },
        },
        Command::Auth(Auth::Rotate { scope,yes }) => { output::confirm(yes,"Revoking the previous scoped credential")?; client.rotate(scope.as_str()).await },
        _ => Err(fail("usage","Command does not support a service connection",2)),
    }
}
async fn doctor(root: &Path, session: &str, timeout: u64) -> Result<Value> {
    let session_path = tucano_service::session_path(root, session)?;
    let mut checks = vec![
        json!({"name":"binary","ok":true,"version":env!("CARGO_PKG_VERSION"),"path":std::env::current_exe()?}),
        json!({"name":"dataDirectory","exists":root.exists(),"path":root}),
        json!({"name":"session","exists":session_path.exists(),"path":session_path}),
        json!({"name":"terminal","stdin":io::stdin().is_terminal(),"stdout":io::stdout().is_terminal()}),
    ];
    match lifecycle::connect(root,session,timeout.min(3)).await {
        Ok((runtime,client)) => {
            checks.push(json!({"name":"service","ok":true,"endpoint":runtime.endpoint}));
            match client.invoke("get_status",json!({})).await {
                Ok(status) => { checks.push(json!({"name":"capture","ok":status["running"],"port":status["port"]})); checks.push(json!({"name":"certificateTrust","ok":status["caInstalled"],"note":"Applications may use independent trust stores; export the CA for runtime-specific trust."})); checks.push(json!({"name":"systemProxy","enabled":status["systemProxyOn"],"note":"OS proxy is optional. Configure target application proxy explicitly."})); },
                Err(error) => checks.push(json!({"name":"capture","ok":false,"error":error.to_string()})),
            }
        },
        Err(error) => checks.push(json!({"name":"service","ok":false,"error":error.to_string(),"remedy":"Run start, or inspect this session's service.log if startup failed."})),
    }
    for (name, port) in [("defaultWebPort", 7777), ("defaultProxyPort", 8888)] {
        let occupied = tokio::time::timeout(
            Duration::from_millis(250),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .is_ok_and(|result| result.is_ok());
        checks.push(json!({"name":name,"port":port,"acceptingConnections":occupied,"note":"An open port may belong to Tucano or another application; this check does not claim ownership."}));
    }
    Ok(json!({"session":session,"checks":checks,"mutated":false}))
}
