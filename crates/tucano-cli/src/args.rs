use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "tucano-proxy",
    version,
    about = "Local HTTP(S) inspection for terminals, browsers and agents",
    after_help = "No command runs first-use setup on an interactive terminal, then opens the TUI on later launches. Pipelines print help without prompting.\nExit codes: 0 success, 2 usage, 3 service unavailable, 4 authentication, 5 local I/O, 6 operation failed, 7 confirmation required.\nCapture never changes the OS proxy unless --system-proxy --yes is explicitly supplied.\nA background service persists after the CLI/TUI exits; use stop to shut it down."
)]
pub struct Cli {
    #[arg(long, global = true, default_value = "default", env = "TUCANO_SESSION")]
    pub session: String,
    #[arg(long, global = true, env = "TUCANO_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
    #[arg(long, global = true, help = "Emit versioned JSON only on stdout")]
    pub json: bool,
    #[arg(long, global = true, value_enum, default_value = "auto")]
    pub color: Color,
    #[arg(long, global = true, default_value = "30", value_parser = clap::value_parser!(u64).range(1..), help = "HTTP/readiness timeout in seconds")]
    pub timeout: u64,
    #[command(subcommand)]
    pub command: Option<Command>,
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Color {
    Auto,
    Always,
    Never,
}
#[derive(Clone, Copy, ValueEnum)]
pub enum WebTarget {
    Auto,
    Browser,
    Maestri,
    Orca,
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Theme {
    Auto,
    Dark,
    Light,
}
impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Scope {
    Read,
    Admin,
}
impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Admin => "admin",
        }
    }
}
#[derive(Clone, Copy, ValueEnum)]
pub enum Format {
    Har,
    Curl,
    Json,
}
impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Har => "har",
            Self::Curl => "curl",
            Self::Json => "json",
        }
    }
}
#[derive(Args)]
pub struct Start {
    #[arg(
        long,
        help = "Run attached until Ctrl-C instead of starting a persistent child"
    )]
    pub foreground: bool,
    #[arg(long, help = "Proxy port (saved setup port, otherwise 8888)")]
    pub proxy_port: Option<u16>,
    #[arg(long, help = "Web/API port (saved setup port, otherwise 7777)")]
    pub web_port: Option<u16>,
    #[arg(
        long,
        help = "Explicitly route OS traffic through the proxy (requires --yes)"
    )]
    pub system_proxy: bool,
    #[arg(long)]
    pub yes: bool,
    #[arg(long, help = "Open authenticated local web UI in the default browser")]
    pub open: bool,
}
#[derive(Subcommand)]
pub enum Command {
    /// Start capture and the local web/API service; defaults to a persistent background child
    Start(Start),
    /// Run service in the foreground (also used for managed background children)
    Serve {
        #[arg(long, help = "Proxy port (saved setup port, otherwise 8888)")]
        proxy_port: Option<u16>,
        #[arg(long, help = "Web/API port (saved setup port, otherwise 7777)")]
        web_port: Option<u16>,
        #[arg(long)]
        no_capture: bool,
        #[arg(long)]
        system_proxy: bool,
        #[arg(long)]
        yes: bool,
    },
    /// Gracefully shut down this session's verified service (never kills a PID)
    Stop,
    /// Show session/service state without exposing credentials
    Status,
    /// Start or locate the local browser UI without implicitly enabling capture
    Web {
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        open: bool,
        #[arg(
            long,
            value_enum,
            default_value = "auto",
            requires = "open",
            help = "Open in auto, browser, Maestri Portal or Orca; auto asks on interactive app terminals"
        )]
        target: WebTarget,
    },
    /// Open the full-screen terminal inspector (requires a terminal)
    Tui {
        #[arg(long, value_enum, default_value = "auto")]
        theme: Theme,
    },
    /// Report local installation and connection diagnostics without changing system settings
    Doctor,
    /// Configure this session interactively, or inspect its existing certificate without changes
    Setup {
        #[arg(
            long,
            help = "Inspect setup and exact certificate trust without changing anything"
        )]
        status: bool,
    },
    /// Check official CLI releases and explicitly update only this executable
    Update {
        #[arg(
            long,
            conflicts_with = "yes",
            help = "Check for an available CLI upgrade without installing it"
        )]
        check: bool,
        #[arg(
            long,
            help = "Explicitly approve executable replacement; required for automation"
        )]
        yes: bool,
    },
    /// Bridge MCP stdio to the configured local Tucano service
    McpStdio,
    /// Query, inspect, annotate, mark and delete captured traffic
    #[command(subcommand)]
    Flows(Flows),
    /// Control the capture listener independently of the local service
    #[command(subcommand)]
    Capture(Capture),
    /// Replay a captured request; omitted headers/body preserve the original
    Replay {
        id: String,
        #[arg(short = 'H', long = "header")]
        headers: Vec<String>,
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
    },
    /// Send a real HTTP request and optionally retain it in this session
    Compose {
        url: String,
        #[arg(short = 'X', long, default_value = "GET")]
        method: String,
        #[arg(short = 'H', long = "header")]
        headers: Vec<String>,
        #[arg(long, conflicts_with = "body_file")]
        body: Option<String>,
        #[arg(long, help = "UTF-8 body file, or - for stdin")]
        body_file: Option<PathBuf>,
        #[arg(long, help = "Do not retain the composed request")]
        no_log: bool,
    },
    /// Export retained flows as HAR, curl commands, or JSON
    Export {
        #[arg(long, value_enum, default_value = "har")]
        format: Format,
        #[arg(long = "id")]
        ids: Vec<String>,
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long, help = "Allow overwriting an existing output file")]
        yes: bool,
    },
    /// Manage named sessions and portable SQLite imports/exports
    #[command(subcommand)]
    Session(Session),
    /// Inspect, export or explicitly change trust for this session's CA
    #[command(subcommand)]
    Ca(Ca),
    /// Configure TLS interception rules and explicit development exceptions
    #[command(subcommand)]
    Ssl(Ssl),
    /// Control private capture, which erases and stops retaining traffic
    #[command(subcommand)]
    Privacy(Privacy),
    /// Inspect or change persistent capture retention
    #[command(subcommand)]
    Config(Config),
    /// Generate shell completion scripts; --json returns the script in the result envelope
    Completions { shell: clap_complete::Shell },
    /// Install and manage the official skill for coding agents
    #[command(subcommand)]
    Skill(Skill),
    /// Inspect or rotate scoped local control credentials
    #[command(subcommand)]
    Auth(Auth),
}
#[derive(Subcommand)]
pub enum Flows {
    /// Query summaries; filters: host/path/method/status/duration/mime/scheme and free text
    List {
        #[arg(long, default_value = "")]
        filter: String,
        #[arg(long, default_value_t = 0)]
        offset: usize,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long, default_value = "startedAt", value_parser = ["startedAt", "duration", "status", "method", "host", "path", "size"])]
        sort: String,
        #[arg(long)]
        descending: bool,
    },
    /// Retrieve one flow, including captured bodies
    Get { id: String },
    /// Permanently delete selected flows
    Delete {
        #[arg(required = true)]
        ids: Vec<String>,
        #[arg(long)]
        yes: bool,
    },
    /// Permanently clear all retained traffic
    Clear {
        #[arg(long)]
        yes: bool,
    },
    /// Set a flow note, or remove it with --clear
    Note {
        id: String,
        #[arg(required_unless_present = "clear", conflicts_with = "clear")]
        note: Option<String>,
        #[arg(long)]
        clear: bool,
    },
    /// Set a persistent flow mark, or remove it with --clear
    Mark {
        id: String,
        #[arg(required_unless_present = "clear", conflicts_with = "clear")]
        mark: Option<String>,
        #[arg(long)]
        clear: bool,
    },
}
#[derive(Subcommand)]
pub enum Capture {
    /// Start listening; OS proxy is changed only with --system-proxy --yes
    Start {
        #[arg(long, help = "Proxy port (current session port when omitted)")]
        port: Option<u16>,
        #[arg(long)]
        system_proxy: bool,
        #[arg(long)]
        yes: bool,
    },
    /// Stop capture and restore any system proxy owned by this service
    Stop,
}
#[derive(Subcommand)]
pub enum Session {
    List,
    Create {
        name: String,
    },
    /// Delete an inactive named session; an active service prevents deletion
    Delete {
        name: String,
        #[arg(long)]
        yes: bool,
    },
    /// Save a portable SQLite session from the running service
    Export {
        output: PathBuf,
        #[arg(long = "id")]
        ids: Vec<String>,
        #[arg(long)]
        yes: bool,
    },
    /// Atomically replace retained flows with a validated SQLite session
    Import {
        input: PathBuf,
        #[arg(long)]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Ca {
    Status,
    Export {
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long)]
        yes: bool,
    },
    /// Install this session's CA in the OS trust store; may require OS authorization
    Install {
        #[arg(long)]
        yes: bool,
    },
    /// Remove this session's CA from the OS trust store; may require OS authorization
    Uninstall {
        #[arg(long)]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Ssl {
    Get,
    Set {
        #[arg(long, value_parser = ["all", "allowlist", "blocklist"])]
        mode: String,
        #[arg(long = "host")]
        hosts: Vec<String>,
        #[arg(long = "skip-host")]
        skip_hosts: Vec<String>,
        #[arg(
            long = "insecure-host",
            help = "Exact development hostname whose upstream CA verification is bypassed (requires --yes)"
        )]
        insecure_hosts: Vec<String>,
        #[arg(long, help = "Acknowledge explicit upstream TLS trust exceptions")]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Privacy {
    Get,
    Set {
        #[arg(action = clap::ArgAction::Set, value_parser = clap::value_parser!(bool))]
        enabled: bool,
        #[arg(long, help = "Required when enabling: retained traffic is erased")]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Config {
    /// Show persistent capture retention configuration
    Get,
    /// Set persistent retained flow limit (0 means unlimited)
    Set {
        #[arg(long)]
        keep_limit: usize,
        #[arg(long, help = "Allow retained flows to be trimmed by a lower limit")]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Auth {
    /// Explicitly reveal a scoped local credential; never include this output in logs
    Show {
        #[arg(long, value_enum, default_value = "read")]
        scope: Scope,
    },
    /// Revoke the previous scoped credential and issue a new one (requires admin)
    Rotate {
        #[arg(long, value_enum, default_value = "read")]
        scope: Scope,
        #[arg(long)]
        yes: bool,
    },
}
#[derive(Subcommand)]
pub enum Skill {
    /// Install the official portable skill into known agent skill directories
    Install {
        #[arg(long, value_parser = ["claude", "codex", "opencode", "pi", "oh-my-pi", "agents", "all"], default_value = "agents")]
        agent: String,
        #[arg(
            long,
            help = "Install in the current project rather than your home directory"
        )]
        project: bool,
        #[arg(long, help = "Replace an existing skill file")]
        yes: bool,
    },
    /// Report precise file coverage for known skill directories; does not imply agent availability
    Status {
        #[arg(long)]
        project: bool,
    },
    /// Remove only the installed Tucano skill, leaving other skills intact
    Uninstall {
        #[arg(long, value_parser = ["claude", "codex", "opencode", "pi", "oh-my-pi", "agents", "all"], default_value = "agents")]
        agent: String,
        #[arg(long)]
        project: bool,
        #[arg(long)]
        yes: bool,
    },
}
