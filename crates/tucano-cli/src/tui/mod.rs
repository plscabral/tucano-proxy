mod preview;
pub(crate) mod terminal;
mod view;

use crate::client::Client;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use crossterm::event::{
    Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use futures_util::StreamExt;
use ratatui::{backend::CrosstermBackend, layout::Rect, widgets::TableState, Terminal};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io,
    time::{Duration, Instant},
};
use terminal::{safe, single, Guard, Logo, Palette};
use tokio::task::{AbortHandle, JoinSet};

const PAGE: usize = 250;
const BODY_LIMIT: usize = 131_072;
const SORTS: [&str; 6] = ["index", "duration", "status", "method", "host", "path"];
const TABS: [&str; 7] = [
    "Overview", "Headers", "Body", "Raw", "Hex", "Timing", "Note",
];
const COLUMNS: [&str; 8] = [
    "#", "Method", "Status", "Host", "Path", "Time", "Size", "Mark",
];

pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn number(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}
fn id(v: &Value) -> &str {
    text(v, "id")
}
fn printable(v: &Value, key: &str) -> String {
    match v.get(key) {
        None | Some(Value::Null) => "-".into(),
        Some(Value::String(s)) => single(s),
        Some(value) => single(&value.to_string()),
    }
}
fn detail_signature(flow: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        id(flow),
        flow["endedAt"],
        flow["status"],
        flow["reqSize"],
        flow["resSize"],
        flow["note"],
        flow["mark"]
    )
}
fn url(flow: &Value) -> String {
    let scheme = text(flow, "scheme");
    let host = text(flow, "host");
    let port = number(flow, "port");
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let port =
        if port == 0 || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
            String::new()
        } else {
            format!(":{port}")
        };
    format!("{scheme}://{authority}{port}{}", text(flow, "path"))
}
fn headers(flow: &Value, response: bool) -> String {
    let key = if response { "resHeaders" } else { "reqHeaders" };
    flow.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(1000)
                .map(|item| {
                    format!(
                        "{}: {}",
                        single(item[0].as_str().unwrap_or("")),
                        single(item[1].as_str().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn body_bytes(flow: &Value, response: bool) -> Vec<u8> {
    let body = text(flow, if response { "resBody" } else { "reqBody" });
    if text(
        flow,
        if response {
            "resBodyEncoding"
        } else {
            "reqBodyEncoding"
        },
    ) == "base64"
    {
        // Decode only the visible prefix; every four base64 bytes are independent.
        let end = body.len().min((BODY_LIMIT / 3 + 1) * 4);
        let mut bytes = STANDARD
            .decode(&body.as_bytes()[..end - end % 4])
            .unwrap_or_else(|_| b"[Invalid base64 capture]".to_vec());
        bytes.truncate(BODY_LIMIT);
        bytes
    } else {
        body.as_bytes()[..body.len().min(BODY_LIMIT)].to_vec()
    }
}
fn body_text(flow: &Value, response: bool, pretty: bool) -> String {
    let bytes = body_bytes(flow, response);
    let raw = String::from_utf8_lossy(&bytes);
    let body = if pretty {
        serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or_else(|| raw.into_owned())
    } else {
        raw.into_owned()
    };
    inspected_text(flow, response, &body)
}

fn inspected_text(flow: &Value, response: bool, body: &str) -> String {
    let mut result = safe(body);
    let original = text(flow, if response { "resBody" } else { "reqBody" });
    let original_size = if text(
        flow,
        if response {
            "resBodyEncoding"
        } else {
            "reqBodyEncoding"
        },
    ) == "base64"
    {
        (original.len() / 4 * 3)
            .saturating_sub(original.bytes().rev().take_while(|&b| b == b'=').count())
    } else {
        original.len()
    };
    if original_size > BODY_LIMIT {
        result.push_str(
            "\n[Preview limited to 128 KiB. Export JSON/HAR for the full captured body.]",
        );
    }
    if flow[if response {
        "resTruncated"
    } else {
        "reqTruncated"
    }]
    .as_bool()
        == Some(true)
    {
        result.push_str("\n[The captured body is truncated; the original transfer was larger.]");
    }
    if result.is_empty() {
        result = "[No captured body]".into();
    }
    result
}

#[derive(Clone)]
struct Input {
    label: &'static str,
    value: String,
    cursor: usize,
}
impl Input {
    fn new(label: &'static str, value: impl Into<String>) -> Self {
        let value = safe(&value.into());
        let cursor = value.len();
        Self {
            label,
            value,
            cursor,
        }
    }
    fn insert(&mut self, value: &str) {
        let clean = safe(value);
        if self.value.len() + clean.len() > 1_048_576 {
            return;
        }
        self.value.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }
    fn vertical(&mut self, delta: isize) {
        let starts: Vec<_> = std::iter::once(0)
            .chain(self.value.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        let row = starts
            .partition_point(|&start| start <= self.cursor)
            .saturating_sub(1);
        let column = self.value[starts[row]..self.cursor].chars().count();
        let target = row.saturating_add_signed(delta).min(starts.len() - 1);
        let end = starts
            .get(target + 1)
            .map(|n| n - 1)
            .unwrap_or(self.value.len());
        let line = &self.value[starts[target]..end];
        self.cursor = starts[target]
            + line
                .char_indices()
                .nth(column)
                .map(|(i, _)| i)
                .unwrap_or(line.len());
    }
    fn place(&mut self, row: usize, column: usize) {
        let start = std::iter::once(0)
            .chain(self.value.match_indices('\n').map(|(i, _)| i + 1))
            .nth(row)
            .unwrap_or(self.value.len());
        let line = self.value[start..].split('\n').next().unwrap_or("");
        let mut width = 0;
        self.cursor = start + line.len();
        for (index, character) in line.char_indices() {
            let next = width + unicode_width::UnicodeWidthChar::width(character).unwrap_or(0);
            if next > column {
                self.cursor = start + index;
                break;
            }
            width = next;
        }
    }
    fn key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Up => self.vertical(-1),
            KeyCode::Down => self.vertical(1),
            KeyCode::PageUp => self.vertical(-10),
            KeyCode::PageDown => self.vertical(10),
            KeyCode::Home if key.modifiers.contains(KeyModifiers::CONTROL) => self.cursor = 0,
            KeyCode::End if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.cursor = self.value.len()
            }
            KeyCode::Left => {
                self.cursor = self.value[..self.cursor]
                    .char_indices()
                    .next_back()
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            }
            KeyCode::Right => {
                self.cursor += self.value[self.cursor..]
                    .chars()
                    .next()
                    .map(char::len_utf8)
                    .unwrap_or(0)
            }
            KeyCode::Home => {
                self.cursor = self.value[..self.cursor]
                    .rfind('\n')
                    .map(|n| n + 1)
                    .unwrap_or(0)
            }
            KeyCode::End => {
                self.cursor = self.value[self.cursor..]
                    .find('\n')
                    .map(|n| self.cursor + n)
                    .unwrap_or(self.value.len())
            }
            KeyCode::Backspace => {
                if let Some((i, _)) = self.value[..self.cursor].char_indices().next_back() {
                    self.value.drain(i..self.cursor);
                    self.cursor = i;
                }
            }
            KeyCode::Delete => {
                if let Some(c) = self.value[self.cursor..].chars().next() {
                    self.value.drain(self.cursor..self.cursor + c.len_utf8());
                }
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.value.clear();
                self.cursor = 0;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.insert(&c.to_string())
            }
            _ => {}
        }
    }
}
#[derive(Clone)]
enum EditKind {
    Filter,
    Note(String),
    Mark(Vec<String>),
    Export(Vec<String>),
    Compose,
    KeepLimit,
    Ssl,
}
struct Editor {
    kind: EditKind,
    fields: Vec<Input>,
    focus: usize,
}
impl Editor {
    fn new(kind: EditKind, fields: Vec<Input>) -> Self {
        Self {
            kind,
            fields,
            focus: 0,
        }
    }
}
struct Confirmation {
    title: String,
    command: &'static str,
    args: Value,
}
enum Overlay {
    None,
    Help(usize),
    Settings,
    Columns(usize),
    Editor(Editor),
    Confirm(Confirmation),
    Diff(Value, Value),
}
struct App {
    flows: Vec<Value>,
    total: usize,
    offset: usize,
    selected: usize,
    table: TableState,
    detail: Option<Value>,
    detail_key: String,
    detail_pending: bool,
    detail_retry: Option<(String, Instant)>,
    selected_ids: HashSet<String>,
    filter: String,
    sort: usize,
    descending: bool,
    follow: bool,
    capture: bool,
    port: u16,
    connected: bool,
    query_pending: bool,
    reload_page: bool,
    generation: u64,
    tab: usize,
    response: bool,
    pretty: bool,
    wrap: bool,
    scroll: u16,
    horizontal: u16,
    inspector_focus: bool,
    inspector_only: bool,
    overlay: Overlay,
    status: String,
    theme: String,
    color: Option<bool>,
    palette: Palette,
    auto_dark: bool,
    columns: [bool; 8],
    table_area: Rect,
    inspector_area: Rect,
    tabs_area: Rect,
    compose_task: Option<AbortHandle>,
    compose_generation: u64,
    private: bool,
    keep_limit: u64,
    ssl: Value,
    settings_pending: bool,
    preview: Option<(String, String, usize)>,
    editor_hits: Vec<(Rect, usize, usize)>,
    dirty: bool,
}
impl App {
    fn new(theme: &str, auto_dark: bool, color: Option<bool>) -> Self {
        Self {
            flows: Vec::new(),
            total: 0,
            offset: 0,
            selected: 0,
            table: TableState::default(),
            detail: None,
            detail_key: String::new(),
            detail_pending: false,
            detail_retry: None,
            selected_ids: HashSet::new(),
            filter: String::new(),
            sort: 0,
            descending: true,
            follow: true,
            capture: false,
            port: 8080,
            connected: false,
            query_pending: false,
            reload_page: true,
            generation: 0,
            tab: 0,
            response: true,
            pretty: true,
            wrap: true,
            scroll: 0,
            horizontal: 0,
            inspector_focus: false,
            inspector_only: false,
            overlay: Overlay::None,
            status: "Connecting to local session...".into(),
            theme: theme.into(),
            color,
            palette: Palette::new(
                if theme == "light" {
                    false
                } else if theme == "dark" {
                    true
                } else {
                    auto_dark
                },
                color,
            ),
            auto_dark,
            columns: [true; 8],
            table_area: Rect::default(),
            inspector_area: Rect::default(),
            tabs_area: Rect::default(),
            compose_task: None,
            compose_generation: 0,
            private: false,
            keep_limit: 0,
            ssl: Value::Null,
            settings_pending: false,
            preview: None,
            editor_hits: Vec::new(),
            dirty: true,
        }
    }
    fn current(&self) -> Option<&Value> {
        self.flows.get(self.selected)
    }
    fn selected_detail(&self) -> Option<&Value> {
        self.detail
            .as_ref()
            .filter(|flow| self.current().map(id) == Some(id(flow)))
    }
    fn sync_detail_selection(&mut self) {
        if self.detail.is_some() && self.selected_detail().is_none() {
            self.detail = None;
            self.detail_key.clear();
            self.preview = None;
        }
    }
    fn ids(&self) -> Vec<String> {
        if self.selected_ids.is_empty() {
            self.current()
                .map(|v| vec![id(v).to_owned()])
                .unwrap_or_default()
        } else {
            let mut ids: Vec<_> = self.selected_ids.iter().cloned().collect();
            ids.sort();
            ids
        }
    }
    fn move_selection(&mut self, delta: isize) {
        self.selected = self
            .selected
            .saturating_add_signed(delta)
            .min(self.flows.len().saturating_sub(1));
        self.follow = false;
        self.scroll = 0;
        self.horizontal = 0;
        self.dirty = true;
        self.sync_detail_selection();
    }
    fn refresh(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.reload_page = true;
        self.dirty = true;
    }
    fn set_theme(&mut self, theme: &str) {
        self.theme = theme.into();
        self.palette = Palette::new(
            match theme {
                "light" => false,
                "dark" => true,
                _ => self.auto_dark,
            },
            self.color,
        );
        self.dirty = true;
    }
}

enum Reply {
    Query(u64, Result<(Value, Value)>),
    Detail(String, String, Result<Value>),
    Action(&'static str, Value, String, Result<Value>),
    Compose(u64, Result<Value>),
    Diff(Result<(Value, Value)>),
    Export(Result<String>),
    Settings(Result<(Value, Value, Value)>),
}
fn action(
    jobs: &mut JoinSet<Reply>,
    client: &Client,
    command: &'static str,
    args: Value,
    message: impl Into<String>,
) {
    let client = client.clone();
    let message = message.into();
    let update = if matches!(
        command,
        "update_flow_note"
            | "update_flow_mark"
            | "delete_flows"
            | "clear_flows"
            | "set_private_mode"
    ) {
        args.clone()
    } else {
        Value::Null
    };
    jobs.spawn(async move {
        Reply::Action(command, update, message, client.invoke(command, args).await)
    });
}
fn query(app: &mut App, client: &Client, jobs: &mut JoinSet<Reply>) {
    if app.query_pending {
        return;
    }
    app.query_pending = true;
    let generation = app.generation;
    let args = json!({"filter":app.filter,"offset":app.offset,"limit":PAGE,"sort":SORTS[app.sort],"descending":app.descending});
    let client = client.clone();
    jobs.spawn(async move {
        let (flows, status) = tokio::join!(
            client.invoke("query_flows", args),
            client.invoke("get_status", json!({}))
        );
        Reply::Query(generation, flows.and_then(|f| status.map(|s| (f, s))))
    });
}
fn detail(app: &mut App, client: &Client, jobs: &mut JoinSet<Reply>) {
    // Selection validity must be established even while another body's RPC is
    // in flight. No renderer or request action may consume that previous body.
    app.sync_detail_selection();
    if app.detail_pending {
        return;
    }
    let Some(flow) = app.current() else {
        app.detail = None;
        app.detail_key.clear();
        return;
    };
    let flow_id = id(flow).to_owned();
    if app
        .detail_retry
        .as_ref()
        .is_some_and(|(retry_id, at)| retry_id == &flow_id && Instant::now() < *at)
    {
        return;
    }
    let key = detail_signature(flow);
    if key == app.detail_key {
        return;
    }
    app.detail_pending = true;
    app.dirty = true;
    let client = client.clone();
    jobs.spawn(async move {
        let result = client.invoke("get_flow", json!({"id":flow_id})).await;
        Reply::Detail(flow_id, key, result)
    });
}
fn handle_reply(app: &mut App, reply: Reply) {
    app.dirty = true;
    match reply {
        Reply::Query(generation, result) => {
            app.query_pending = false;
            if generation != app.generation {
                return;
            }
            match result {
                Ok((flows, status)) => {
                    let old = app.current().map(|v| id(v).to_owned());
                    let items = flows["items"].as_array().cloned().unwrap_or_default();
                    if app.follow || app.reload_page || app.flows.is_empty() {
                        app.flows = items;
                        app.reload_page = false;
                    } else {
                        // Pause freezes the viewport, not capture or status polling.
                        // New arrivals cannot evict an inspected row off a page.
                        let updates: HashMap<_, _> =
                            items.iter().map(|flow| (id(flow), flow)).collect();
                        for flow in &mut app.flows {
                            if let Some(update) = updates.get(id(flow)) {
                                *flow = (**update).clone();
                            }
                        }
                    }
                    app.total = number(&flows, "total") as usize;
                    app.capture = status["running"].as_bool().unwrap_or(false);
                    app.port = number(&status, "port") as u16;
                    if app.port == 0 {
                        app.port = 8080;
                    }
                    if app.follow {
                        app.selected = if app.descending {
                            0
                        } else {
                            app.flows.len().saturating_sub(1)
                        };
                    } else if let Some(index) =
                        old.and_then(|old| app.flows.iter().position(|v| id(v) == old))
                    {
                        app.selected = index;
                    }
                    app.selected = app.selected.min(app.flows.len().saturating_sub(1));
                    if !app.connected {
                        app.status = "Connected. Traffic stays in this session when you quit. Press ? for help.".into();
                        app.detail_key.clear();
                        app.detail_retry = None;
                    }
                    app.connected = true;
                }
                Err(error) => {
                    app.connected = false;
                    app.status = format!(
                        "Disconnected: {}. Retrying; q leaves the service running.",
                        single(&error.to_string())
                    );
                }
            }
        }
        Reply::Detail(flow_id, key, result) => {
            app.detail_pending = false;
            app.preview = None;
            if app.current().map(id) != Some(flow_id.as_str()) {
                return;
            }
            match result {
                Ok(value) if !value.is_null() => {
                    app.detail_retry = None;
                    // A paused row can have left the latest query window. Bring
                    // its completion/annotation summary up to date from this one
                    // selected detail without copying its captured bodies.
                    if let Some(summary) = app.flows.get_mut(app.selected) {
                        for field in [
                            "endedAt",
                            "status",
                            "durationMs",
                            "reqSize",
                            "resSize",
                            "note",
                            "mark",
                            "error",
                        ] {
                            summary[field] = value[field].clone();
                        }
                    }
                    app.detail_key = detail_signature(&value);
                    app.detail = Some(value);
                }
                Ok(_) => {
                    app.detail_retry = None;
                    app.detail = None;
                    app.detail_key = key;
                    app.status = "Capture no longer exists; refresh the list.".into();
                }
                Err(error) => {
                    app.detail_key.clear();
                    app.detail_retry = Some((flow_id, Instant::now() + Duration::from_secs(2)));
                    app.status = format!(
                        "Inspector: {}. Retrying in 2 seconds.",
                        single(&error.to_string())
                    );
                }
            }
        }
        Reply::Action(command, update, message, result) => match result {
            Ok(_) => {
                match command {
                    "delete_flows" => {
                        if let Some(ids) = update["ids"].as_array() {
                            app.flows.retain(|flow| {
                                !ids.iter().any(|value| value.as_str() == Some(id(flow)))
                            });
                        }
                    }
                    "clear_flows" => app.flows.clear(),
                    "set_private_mode" if update["enabled"] == true => app.flows.clear(),
                    "update_flow_note" => {
                        for flow in &mut app.flows {
                            if id(flow) == text(&update, "id") {
                                flow["note"] = update["note"].clone();
                            }
                        }
                    }
                    "update_flow_mark" => {
                        for flow in &mut app.flows {
                            if update["ids"].as_array().is_some_and(|ids| {
                                ids.iter().any(|value| value.as_str() == Some(id(flow)))
                            }) {
                                flow["mark"] = update["mark"].clone();
                            }
                        }
                    }
                    _ => {}
                }
                app.selected = app.selected.min(app.flows.len().saturating_sub(1));
                app.status = message;
                app.detail_key.clear();
                app.detail_retry = None;
                app.generation = app.generation.wrapping_add(1);
            }
            Err(error) => app.status = format!("Action failed: {}", single(&error.to_string())),
        },
        Reply::Compose(generation, result) => {
            if generation != app.compose_generation {
                return;
            }
            app.compose_task = None;
            match result {
                Ok(flow) => {
                    app.status = format!(
                        "Request completed: HTTP {} in {} ms. Captured as #{}.",
                        printable(&flow, "status"),
                        printable(&flow, "durationMs"),
                        printable(&flow, "index")
                    );
                    app.detail = Some(flow.clone());
                    app.detail_key.clear();
                    app.follow = false;
                    if let Some(index) = app.flows.iter().position(|v| id(v) == id(&flow)) {
                        app.selected = index;
                    } else {
                        app.flows.insert(0, flow);
                        app.selected = 0;
                    }
                    app.overlay = Overlay::None;
                    app.tab = 2;
                    app.response = true;
                    app.inspector_focus = true;
                    app.scroll = 0;
                }
                Err(error) => {
                    app.status = format!("Request failed: {}", single(&error.to_string()))
                }
            }
        }
        Reply::Diff(result) => match result {
            Ok((a, b)) => {
                app.overlay = Overlay::Diff(a, b);
                app.scroll = 0;
            }
            Err(error) => app.status = format!("Comparison failed: {}", single(&error.to_string())),
        },
        Reply::Export(result) => match result {
            Ok(path) => app.status = format!("Saved {}", single(&path)),
            Err(error) => app.status = format!("Export failed: {}", single(&error.to_string())),
        },
        Reply::Settings(result) => {
            app.settings_pending = false;
            match result {
                Ok((private, limit, ssl)) => {
                    app.private = private.as_bool().unwrap_or(false);
                    app.keep_limit = limit.as_u64().unwrap_or(0);
                    app.ssl = ssl;
                }
                Err(error) => app.status = format!("Settings: {}", single(&error.to_string())),
            }
        }
    }
}

async fn exit_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
            _ = hangup.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

/// The terminal owns only its view and client requests, never the proxy service.
/// Every network operation runs in a cancellable task, independently of input.
pub async fn run(client: Client, theme: &str, color: Option<bool>) -> Result<()> {
    anyhow::ensure!(
        matches!(theme, "auto" | "dark" | "light"),
        "Theme must be auto, dark or light"
    );
    let _guard = Guard::enter()?;
    let automatic_dark = if theme == "auto" && terminal::colors_enabled(color) {
        terminal::auto_dark()
    } else {
        theme != "light"
    };
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let mut logo = Logo::new(color);
    let mut app = App::new(theme, automatic_dark, color);
    let mut events = EventStream::new();
    let mut jobs = JoinSet::new();
    let mut interval = tokio::time::interval(Duration::from_millis(800));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let exit_signal = exit_signal();
    tokio::pin!(exit_signal);
    query(&mut app, &client, &mut jobs);
    loop {
        if app.dirty {
            terminal.draw(|frame| view::draw(frame, &mut app, logo.enabled()))?;
            logo.draw()?;
            app.dirty = false;
        }
        tokio::select! {
            result = &mut exit_signal => { result?; break; },
            event = events.next() => match event {
                Some(Ok(Event::Key(key))) if key.kind != KeyEventKind::Release => {
                    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) { break; }
                    if handle_key(&mut app, key, &client, &mut jobs)? { break; }
                    app.dirty = true;
                }
                Some(Ok(Event::Mouse(mouse))) => {
                    if matches!(app.overlay, Overlay::None) {
                        match mouse.kind {
                            MouseEventKind::ScrollDown => if app.inspector_area.contains((mouse.column,mouse.row).into()) { app.scroll = app.scroll.saturating_add(3); } else { app.move_selection(3); },
                            MouseEventKind::ScrollUp => if app.inspector_area.contains((mouse.column,mouse.row).into()) { app.scroll = app.scroll.saturating_sub(3); } else { app.move_selection(-3); },
                            MouseEventKind::Down(MouseButton::Left) => {
                                if app.table_area.contains((mouse.column,mouse.row).into()) {
                                    let row = mouse.row.saturating_sub(app.table_area.y + 2) as usize + app.table.offset();
                                    if row < app.flows.len() && mouse.row >= app.table_area.y + 2 {
                                        if mouse.modifiers.contains(KeyModifiers::SHIFT) {
                                            for flow in &app.flows[app.selected.min(row)..=app.selected.max(row)] { app.selected_ids.insert(id(flow).to_owned()); }
                                        } else if mouse.modifiers.contains(KeyModifiers::CONTROL) {
                                            let id = id(&app.flows[row]).to_owned();
                                            if !app.selected_ids.remove(&id) { app.selected_ids.insert(id); }
                                        }
                                        app.selected = row; app.follow = false; app.inspector_focus = false; app.scroll = 0;
                                    }
                                } else if app.tabs_area.contains((mouse.column,mouse.row).into()) {
                                    if app.tabs_area.width < 62 {
                                        app.tab = if mouse.column < app.tabs_area.x + app.tabs_area.width / 2 { (app.tab + TABS.len() - 1) % TABS.len() } else { (app.tab + 1) % TABS.len() };
                                        app.scroll = 0;
                                    } else {
                                        let mut x = app.tabs_area.x;
                                        for (i, label) in TABS.iter().enumerate() { let width = label.len() as u16 + 3; if mouse.column >= x && mouse.column < x + width { app.tab = i; app.scroll = 0; break; } x += width; }
                                    }
                                    app.inspector_focus = true;
                                } else if app.inspector_area.contains((mouse.column,mouse.row).into()) { app.inspector_focus = true; }
                            }
                            _ => {}
                        }
                    } else if matches!(app.overlay, Overlay::Diff(_,_) | Overlay::Help(_)) {
                        match mouse.kind { MouseEventKind::ScrollDown => app.scroll = app.scroll.saturating_add(3), MouseEventKind::ScrollUp => app.scroll = app.scroll.saturating_sub(3), _ => {} }
                    } else if let Overlay::Editor(editor) = &mut app.overlay {
                        if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                            for (index, (area, scroll_y, scroll_x)) in app.editor_hits.iter().enumerate() {
                                if area.contains((mouse.column,mouse.row).into()) {
                                    editor.focus = index;
                                    editor.fields[index].place(*scroll_y + (mouse.row - area.y) as usize, *scroll_x + (mouse.column - area.x) as usize);
                                    break;
                                }
                            }
                        }
                    }
                    app.dirty = true;
                }
                Some(Ok(Event::Paste(value))) => { if let Overlay::Editor(editor) = &mut app.overlay { editor.fields[editor.focus].insert(&value); app.dirty = true; } }
                Some(Ok(Event::Resize(_, _))) => { logo.invalidate(); app.dirty = true; }
                Some(Err(error)) => return Err(error.into()),
                None => break,
                _ => {}
            },
            _ = interval.tick() => {
                if !app.follow && !app.detail_pending && app.current().is_some_and(|flow| flow["endedAt"].is_null()) {
                    app.detail_key.clear();
                }
                query(&mut app, &client, &mut jobs);
            },
            result = jobs.join_next(), if !jobs.is_empty() => {
                match result { Some(Ok(reply)) => handle_reply(&mut app, reply), Some(Err(error)) if !error.is_cancelled() => { app.status = format!("Background operation failed: {}", single(&error.to_string())); app.dirty = true; }, _ => {} }
            }
        }
        detail(&mut app, &client, &mut jobs);
    }
    jobs.abort_all();
    // Dropping the join set cancels UI-only work. No shutdown RPC is sent.
    Ok(())
}

fn start_composer(app: &mut App, from_flow: bool) {
    let flow = if from_flow {
        app.selected_detail()
    } else {
        None
    };
    if from_flow && flow.is_none() {
        app.status = "Wait for the selected capture's details before composing a replay.".into();
        return;
    }
    if let Some(flow) = flow {
        let original = text(flow, "reqBody");
        if text(flow, "reqBodyEncoding") == "base64" || original != safe(original) {
            app.status = "This body contains binary/control data or exceeds the editor limit. R replays its original bytes unchanged; C creates a new UTF-8 request.".into();
            return;
        }
    }
    let fields = vec![
        Input::new("Method", flow.map(|f| text(f, "method")).unwrap_or("GET")),
        Input::new("URL", flow.map(url).unwrap_or_default()),
        Input::new(
            "Headers (one Name: value per line)",
            flow.map(|f| headers(f, false)).unwrap_or_default(),
        ),
        Input::new(
            "Body (UTF-8)",
            flow.map(|f| text(f, "reqBody")).unwrap_or(""),
        ),
    ];
    app.overlay = Overlay::Editor(Editor::new(EditKind::Compose, fields));
    app.status = "Composer: Tab changes field; Enter adds a line in headers/body; Ctrl+Enter sends; Esc closes.".into();
}
fn settings(app: &mut App, client: &Client, jobs: &mut JoinSet<Reply>) {
    app.overlay = Overlay::Settings;
    if app.settings_pending {
        return;
    }
    app.settings_pending = true;
    let client = client.clone();
    jobs.spawn(async move {
        let (a, b, c) = tokio::join!(
            client.invoke("get_private_mode", json!({})),
            client.invoke("get_keep_limit", json!({})),
            client.invoke("get_ssl_settings", json!({}))
        );
        Reply::Settings(a.and_then(|a| b.and_then(|b| c.map(|c| (a, b, c)))))
    });
}
fn handle_key(
    app: &mut App,
    key: KeyEvent,
    client: &Client,
    jobs: &mut JoinSet<Reply>,
) -> Result<bool> {
    let overlay = std::mem::replace(&mut app.overlay, Overlay::None);
    match overlay {
        Overlay::Editor(mut editor) => {
            if key.code == KeyCode::Esc {
                if matches!(editor.kind, EditKind::Compose) && app.compose_task.is_some() {
                    app.compose_task.take().unwrap().abort();
                    app.compose_generation += 1;
                    app.status = "Stopped waiting for the request. It may already have reached the server and can still appear in captures.".into();
                }
                return Ok(false);
            }
            let multiline = matches!(editor.kind, EditKind::Compose) && editor.focus >= 2
                || matches!(editor.kind, EditKind::Note(_) | EditKind::Ssl);
            if key.code == KeyCode::Tab {
                editor.focus = (editor.focus + 1) % editor.fields.len();
            } else if key.code == KeyCode::BackTab {
                editor.focus = (editor.focus + editor.fields.len() - 1) % editor.fields.len();
            } else if key.code == KeyCode::Enter
                && (key.modifiers.contains(KeyModifiers::CONTROL)
                    || !multiline && !matches!(editor.kind, EditKind::Compose))
            {
                if let Err(error) = submit(app, &editor, client, jobs) {
                    app.status = single(&error.to_string());
                    app.overlay = Overlay::Editor(editor);
                } else if matches!(editor.kind, EditKind::Compose) {
                    app.overlay = Overlay::Editor(editor);
                }
                return Ok(false);
            } else if key.code == KeyCode::F(5) && matches!(editor.kind, EditKind::Compose) {
                if let Err(error) = submit(app, &editor, client, jobs) {
                    app.status = single(&error.to_string());
                }
            } else if key.code == KeyCode::Enter {
                if multiline {
                    editor.fields[editor.focus].insert("\n");
                } else {
                    editor.focus = (editor.focus + 1) % editor.fields.len();
                }
            } else {
                editor.fields[editor.focus].key(key);
            }
            app.overlay = Overlay::Editor(editor);
            return Ok(false);
        }
        Overlay::Confirm(confirm) => {
            if key.code == KeyCode::Char('y') {
                action(
                    jobs,
                    client,
                    confirm.command,
                    confirm.args,
                    "Operation completed",
                );
                app.selected_ids.clear();
            } else if !matches!(key.code, KeyCode::Esc | KeyCode::Char('n')) {
                app.overlay = Overlay::Confirm(confirm);
            }
            return Ok(false);
        }
        Overlay::Columns(mut selected) => {
            match key.code {
                KeyCode::Esc | KeyCode::Enter => return Ok(false),
                KeyCode::Up | KeyCode::Char('k') => selected = selected.saturating_sub(1),
                KeyCode::Down | KeyCode::Char('j') => {
                    selected = (selected + 1).min(COLUMNS.len() - 1)
                }
                KeyCode::Char(' ')
                    if !app.columns[selected] || app.columns.iter().filter(|&&v| v).count() > 1 =>
                {
                    app.columns[selected] = !app.columns[selected];
                }
                _ => {}
            }
            app.overlay = Overlay::Columns(selected);
            return Ok(false);
        }
        Overlay::Settings => {
            match key.code {
                KeyCode::Esc | KeyCode::Char(',') => {}
                KeyCode::Char('a') => {
                    app.set_theme("auto");
                    app.overlay = Overlay::Settings;
                }
                KeyCode::Char('d') => {
                    app.set_theme("dark");
                    app.overlay = Overlay::Settings;
                }
                KeyCode::Char('l') => {
                    app.set_theme("light");
                    app.overlay = Overlay::Settings;
                }
                KeyCode::Char('k') => {
                    app.overlay = Overlay::Editor(Editor::new(
                        EditKind::KeepLimit,
                        vec![Input::new(
                            "Maximum retained captures (0 = unlimited)",
                            app.keep_limit.to_string(),
                        )],
                    ))
                }
                KeyCode::Char('s') => {
                    app.overlay = Overlay::Editor(Editor::new(
                        EditKind::Ssl,
                        vec![Input::new(
                            "TLS settings JSON",
                            serde_json::to_string_pretty(&app.ssl)?,
                        )],
                    ))
                }
                KeyCode::Char('p') => {
                    app.overlay = Overlay::Confirm(Confirmation {
                        title: if app.private {
                            "Disable private capture mode?".into()
                        } else {
                            "Enable private mode? This clears ALL retained captures.".into()
                        },
                        command: "set_private_mode",
                        args: json!({"enabled":!app.private}),
                    })
                }
                _ => app.overlay = Overlay::Settings,
            }
            return Ok(false);
        }
        Overlay::Help(mut page) => {
            match key.code {
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') => {
                    app.scroll = 0;
                    return Ok(false);
                }
                KeyCode::Down | KeyCode::Char('j') => app.scroll = app.scroll.saturating_add(1),
                KeyCode::Up | KeyCode::Char('k') => app.scroll = app.scroll.saturating_sub(1),
                KeyCode::PageDown => app.scroll = app.scroll.saturating_add(12),
                KeyCode::PageUp => app.scroll = app.scroll.saturating_sub(12),
                KeyCode::Right | KeyCode::Tab | KeyCode::Char('l') => {
                    page = (page + 1) % view::HELP_TITLES.len();
                    app.scroll = 0;
                }
                KeyCode::Left | KeyCode::BackTab | KeyCode::Char('h') => {
                    page = (page + view::HELP_TITLES.len() - 1) % view::HELP_TITLES.len();
                    app.scroll = 0;
                }
                KeyCode::Char(c @ '1'..='5') => {
                    page = c as usize - '1' as usize;
                    app.scroll = 0;
                }
                KeyCode::Home | KeyCode::Char('g') => app.scroll = 0,
                KeyCode::End | KeyCode::Char('G') => app.scroll = u16::MAX,
                _ => {}
            }
            app.overlay = Overlay::Help(page);
            return Ok(false);
        }
        Overlay::Diff(a, b) => {
            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => {
                    app.scroll = 0;
                    return Ok(false);
                }
                KeyCode::Down | KeyCode::Char('j') => app.scroll = app.scroll.saturating_add(1),
                KeyCode::Up | KeyCode::Char('k') => app.scroll = app.scroll.saturating_sub(1),
                KeyCode::PageDown => app.scroll = app.scroll.saturating_add(12),
                KeyCode::PageUp => app.scroll = app.scroll.saturating_sub(12),
                KeyCode::Char('b') => app.response = !app.response,
                _ => {}
            }
            app.overlay = Overlay::Diff(a, b);
            return Ok(false);
        }
        Overlay::None => {}
    }
    match key.code {
        KeyCode::Char('q') => return Ok(true),
        KeyCode::Esc => {
            app.selected_ids.clear();
            app.inspector_only = false;
            app.inspector_focus = false;
        }
        KeyCode::Char('?') | KeyCode::F(1) => {
            app.overlay = Overlay::Help(0);
            app.scroll = 0;
        }
        KeyCode::Char(',') => settings(app, client, jobs),
        KeyCode::Tab | KeyCode::BackTab => app.inspector_focus = !app.inspector_focus,
        KeyCode::Enter => {
            app.inspector_only = !app.inspector_only;
            app.inspector_focus = app.inspector_only;
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if app.inspector_focus {
                app.scroll = app.scroll.saturating_add(1);
            } else {
                app.move_selection(1);
            }
        }
        KeyCode::Up | KeyCode::Char('k') => {
            if app.inspector_focus {
                app.scroll = app.scroll.saturating_sub(1);
            } else {
                app.move_selection(-1);
            }
        }
        KeyCode::PageDown => {
            if app.inspector_focus {
                app.scroll = app.scroll.saturating_add(15);
            } else {
                app.move_selection(15);
            }
        }
        KeyCode::PageUp => {
            if app.inspector_focus {
                app.scroll = app.scroll.saturating_sub(15);
            } else {
                app.move_selection(-15);
            }
        }
        KeyCode::Home | KeyCode::Char('g') => {
            if app.inspector_focus {
                app.scroll = 0;
                app.horizontal = 0;
            } else {
                app.move_selection(-(app.selected as isize));
            }
        }
        KeyCode::End | KeyCode::Char('G') => {
            if app.inspector_focus {
                app.scroll = u16::MAX;
            } else {
                app.move_selection(app.flows.len() as isize);
            }
        }
        KeyCode::Left | KeyCode::Right if key.modifiers.contains(KeyModifiers::SHIFT) => {
            app.horizontal = if app.wrap {
                0
            } else if key.code == KeyCode::Left {
                app.horizontal.saturating_sub(8)
            } else {
                app.horizontal.saturating_add(8)
            };
        }
        KeyCode::Left => {
            app.tab = (app.tab + TABS.len() - 1) % TABS.len();
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Right => {
            app.tab = (app.tab + 1) % TABS.len();
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Char(c @ '1'..='7') => {
            app.tab = c as usize - '1' as usize;
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Char('b') => {
            app.response = !app.response;
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Char('J') => {
            app.pretty = !app.pretty;
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Char('w') => {
            app.wrap = !app.wrap;
            app.scroll = 0;
            app.horizontal = 0;
        }
        KeyCode::Char('f') => {
            app.follow = !app.follow;
            if app.follow {
                app.offset = 0;
                app.sort = 0;
                app.descending = true;
                app.refresh();
            }
        }
        KeyCode::Char('c') => {
            if app.capture {
                app.overlay = Overlay::Confirm(Confirmation {
                    title:
                        "Stop the capture listener? Existing captures and service remain available."
                            .into(),
                    command: "stop_proxy",
                    args: json!({}),
                });
            } else {
                action(
                    jobs,
                    client,
                    "start_proxy",
                    json!({"port":app.port}),
                    "Capture listener started. OS proxy settings were not changed.",
                );
            }
        }
        KeyCode::Char('/') => {
            app.overlay = Overlay::Editor(Editor::new(
                EditKind::Filter,
                vec![Input::new(
                    "Filter: host:api method:POST status:>=400 duration:>100",
                    &app.filter,
                )],
            ))
        }
        KeyCode::Char('s') => {
            app.sort = (app.sort + 1) % SORTS.len();
            app.follow = false;
            app.offset = 0;
            app.refresh();
        }
        KeyCode::Char('S') => {
            app.descending = !app.descending;
            app.follow = false;
            app.refresh();
        }
        KeyCode::Char('v') => app.overlay = Overlay::Columns(0),
        KeyCode::Char(']') if app.offset + PAGE < app.total => {
            app.offset += PAGE;
            app.selected = 0;
            app.follow = false;
            app.refresh();
        }
        KeyCode::Char('[') => {
            app.offset = app.offset.saturating_sub(PAGE);
            app.selected = 0;
            app.follow = false;
            app.refresh();
        }
        KeyCode::Char(' ') => {
            if let Some(flow) = app.current() {
                let id = id(flow).to_owned();
                if !app.selected_ids.remove(&id) {
                    app.selected_ids.insert(id);
                }
            }
        }
        KeyCode::Char('a') => {
            for flow in &app.flows {
                app.selected_ids.insert(id(flow).to_owned());
            }
        }
        KeyCode::Char('n') => {
            if let Some(flow) = app.current() {
                app.overlay = Overlay::Editor(Editor::new(
                    EditKind::Note(id(flow).to_owned()),
                    vec![Input::new(
                        "Note (Ctrl+Enter saves, empty removes)",
                        text(flow, "note"),
                    )],
                ));
            }
        }
        KeyCode::Char('m') => {
            let ids = app.ids();
            if !ids.is_empty() {
                app.overlay = Overlay::Editor(Editor::new(
                    EditKind::Mark(ids),
                    vec![Input::new(
                        "Mark label (empty removes)",
                        app.current().map(|v| text(v, "mark")).unwrap_or(""),
                    )],
                ));
            }
        }
        KeyCode::Char('d') | KeyCode::Delete | KeyCode::Backspace => {
            let ids = app.ids();
            if !ids.is_empty() {
                app.overlay = Overlay::Confirm(Confirmation {
                    title: format!("Permanently delete {} selected capture(s)?", ids.len()),
                    command: "delete_flows",
                    args: json!({"ids":ids}),
                });
            } else {
                app.status = "No captures to delete. Select a capture first.".into();
            }
        }
        KeyCode::Char('D') => app.overlay = Overlay::Confirm(Confirmation {
            title:
                "Permanently clear ALL captures in this session, including filtered-out traffic?"
                    .into(),
            command: "clear_flows",
            args: json!({}),
        }),
        KeyCode::Char('e') => {
            app.overlay = Overlay::Editor(Editor::new(
                EditKind::Export(app.selected_ids.iter().cloned().collect()),
                vec![
                    Input::new("Format: har, json, curl, session", "har"),
                    Input::new(
                        "Save to local path (existing files are never overwritten)",
                        "tucano-export.har",
                    ),
                ],
            ))
        }
        KeyCode::Char('C') => start_composer(app, false),
        KeyCode::Char('r') => {
            if app.selected_detail().is_some() {
                start_composer(app, true);
            } else {
                app.status =
                    "Select a capture and wait for its details before composing a replay.".into();
            }
        }
        KeyCode::Char('R') => {
            if let Some(flow) = app.selected_detail() {
                action(
                    jobs,
                    client,
                    "replay_flow",
                    json!({"id":id(flow),"headers":flow["reqHeaders"],"body":null}),
                    "Request replayed; select its new capture to inspect the response",
                );
            } else {
                app.status = "Wait for the selected capture's details before replaying.".into();
            }
        }
        KeyCode::Char('x') => {
            let ids = app.ids();
            if ids.len() != 2 {
                app.status =
                    "Select exactly two captures with Space, then press x to compare.".into();
            } else {
                let client = client.clone();
                jobs.spawn(async move {
                    let (a, b) = tokio::join!(
                        client.invoke("get_flow", json!({"id":ids[0]})),
                        client.invoke("get_flow", json!({"id":ids[1]}))
                    );
                    Reply::Diff(a.and_then(|a| b.map(|b| (a, b))))
                });
                app.status = "Loading comparison...".into();
            }
        }
        KeyCode::F(5) => {
            app.detail_key.clear();
            app.refresh();
        }
        _ => {}
    }
    if !app.query_pending {
        query(app, client, jobs);
    }
    Ok(false)
}
fn submit(
    app: &mut App,
    editor: &Editor,
    client: &Client,
    jobs: &mut JoinSet<Reply>,
) -> Result<()> {
    let value = editor.fields[0].value.trim();
    match &editor.kind {
        EditKind::Filter => {
            app.filter = value.into();
            app.offset = 0;
            app.selected = 0;
            app.refresh();
        }
        EditKind::Note(id) => action(
            jobs,
            client,
            "update_flow_note",
            json!({"id":id,"note":if value.is_empty(){Value::Null}else{json!(editor.fields[0].value)}}),
            "Note saved",
        ),
        EditKind::Mark(ids) => {
            let client = client.clone();
            let ids = ids.clone();
            let mark = if value.is_empty() {
                Value::Null
            } else {
                json!(value)
            };
            jobs.spawn(async move {
                let mut result = Ok(Value::Null);
                for id in &ids {
                    match client
                        .invoke("update_flow_mark", json!({"id":id,"mark":mark}))
                        .await
                    {
                        Ok(v) => result = Ok(v),
                        Err(error) => {
                            result = Err(error);
                            break;
                        }
                    }
                }
                Reply::Action(
                    "update_flow_mark",
                    json!({"ids":ids,"mark":mark}),
                    "Marks saved".into(),
                    result,
                )
            });
        }
        EditKind::KeepLimit => {
            let limit = value
                .parse::<u64>()
                .context("Retention must be a non-negative number")?;
            action(
                jobs,
                client,
                "set_keep_limit",
                json!({"limit":limit}),
                "Retention updated",
            );
            app.keep_limit = limit;
        }
        EditKind::Ssl => {
            let settings: Value =
                serde_json::from_str(value).context("TLS settings must be valid JSON")?;
            anyhow::ensure!(
                matches!(
                    settings["mode"].as_str(),
                    Some("all" | "allowlist" | "blocklist")
                ),
                "TLS mode must be all, allowlist or blocklist"
            );
            anyhow::ensure!(
                settings["hosts"]
                    .as_array()
                    .is_some_and(|v| v.iter().all(Value::is_string))
                    && settings["skipHosts"]
                        .as_array()
                        .is_some_and(|v| v.iter().all(Value::is_string)),
                "hosts and skipHosts must be arrays of host strings"
            );
            action(
                jobs,
                client,
                "set_ssl_settings",
                json!({"settings":settings}),
                "TLS interception settings updated",
            );
        }
        EditKind::Export(ids) => {
            anyhow::ensure!(
                matches!(value, "har" | "json" | "curl" | "session"),
                "Choose har, json, curl or session"
            );
            let format = value.to_owned();
            let path = editor.fields[1].value.trim().to_owned();
            anyhow::ensure!(!path.is_empty(), "Enter a destination path");
            let ids = ids.clone();
            let client = client.clone();
            jobs.spawn(async move { Reply::Export(async {
                let bytes=if format=="session" { client.export_session(if ids.is_empty(){None}else{Some(&ids)}).await? }
                else { client.invoke("export_flows",json!({"format":format,"ids":if ids.is_empty(){Value::Null}else{json!(ids)}})).await?.as_str().ok_or_else(||anyhow!("Export returned a non-text result"))?.as_bytes().to_vec() };
                let saved=path.clone();
                tokio::task::spawn_blocking(move || -> Result<()> {
                    use std::io::Write;
                    let mut options=std::fs::OpenOptions::new(); options.write(true).create_new(true);
                    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
                    let mut file=options.open(&path).with_context(||format!("Cannot create {path}; choose a new filename if it exists"))?;
                    file.write_all(&bytes)?; file.sync_all()?; Ok(())
                }).await??;
                Ok(saved)
            }.await) });
            app.status = "Exporting in the background...".into();
        }
        EditKind::Compose => {
            anyhow::ensure!(
                app.compose_task.is_none(),
                "A request is already running. Esc cancels waiting."
            );
            let method = value.to_ascii_uppercase();
            anyhow::ensure!(
                !method.is_empty()
                    && method
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)),
                "Enter a valid HTTP method"
            );
            let url = editor.fields[1].value.trim();
            anyhow::ensure!(
                url.starts_with("http://") || url.starts_with("https://"),
                "URL must begin with http:// or https://"
            );
            let mut headers = Vec::<(String, String)>::new();
            for line in editor.fields[2]
                .value
                .lines()
                .filter(|line| !line.trim().is_empty())
            {
                let (name, value) = line
                    .split_once(':')
                    .ok_or_else(|| anyhow!("Each header must use Name: value"))?;
                anyhow::ensure!(!name.trim().is_empty(), "Header names cannot be empty");
                headers.push((name.trim().to_owned(), value.trim().to_owned()));
            }
            let body = &editor.fields[3].value;
            let args = json!({"method":method,"url":url,"headers":headers,"body":if body.is_empty(){Value::Null}else{json!(body)},"log":true});
            let client = client.clone();
            app.compose_generation += 1;
            let generation = app.compose_generation;
            app.compose_task = Some(jobs.spawn(async move {
                Reply::Compose(generation, client.invoke("compose_request", args).await)
            }));
            app.status="Sending request... Keyboard remains active. Esc stops waiting; the remote server may already be processing it.".into();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paused_follow_preserves_viewport_after_selection_leaves_query_page() {
        let mut app = App::new("dark", true, Some(false));
        let original: Vec<_> = (1..=PAGE)
            .rev()
            .map(|index| json!({"id":index.to_string(),"index":index}))
            .collect();
        handle_reply(
            &mut app,
            Reply::Query(
                0,
                Ok((
                    json!({"items":original,"total":PAGE}),
                    json!({"running":true,"port":8080}),
                )),
            ),
        );
        app.follow = false;
        app.selected = PAGE - 1;
        *app.table.offset_mut() = PAGE - 10;
        app.scroll = 8;
        let arrivals: Vec<_> = (PAGE + 1..=PAGE * 2)
            .rev()
            .map(|index| json!({"id":index.to_string(),"index":index}))
            .collect();
        handle_reply(
            &mut app,
            Reply::Query(
                0,
                Ok((
                    json!({"items":arrivals,"total":PAGE * 2}),
                    json!({"running":true,"port":8080}),
                )),
            ),
        );
        assert_eq!(app.current().map(id), Some("1"));
        assert_eq!(app.table.offset(), PAGE - 10);
        assert_eq!(app.scroll, 8);
        assert_eq!(app.total, PAGE * 2);
        assert!(app.capture);
    }

    #[test]
    fn pending_old_detail_is_neither_rendered_nor_opened_for_replay() {
        let mut app = App::new("dark", true, Some(false));
        app.flows = vec![json!({"id":"old"}), json!({"id":"selected"})];
        app.detail =
            Some(json!({"id":"old","resBody":"WRONG-REQUEST-RESPONSE","resBodyEncoding":"utf8"}));
        app.detail_pending = true;
        app.selected = 1;
        app.tab = 2;
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(140, 40)).unwrap();
        terminal
            .draw(|frame| view::draw(frame, &mut app, false))
            .unwrap();
        let visible: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(visible.contains("Loading selected capture"));
        assert!(!visible.contains("WRONG-REQUEST-RESPONSE"));
        start_composer(&mut app, true);
        assert!(matches!(app.overlay, Overlay::None));
        app.sync_detail_selection();
        assert!(app.detail.is_none());
    }

    #[test]
    fn failed_detail_remains_retryable_and_reconnect_clears_backoff() {
        let mut app = App::new("dark", true, Some(false));
        app.flows = vec![json!({"id":"selected","endedAt":1})];
        app.reload_page = false;
        let signature = detail_signature(&app.flows[0]);
        handle_reply(
            &mut app,
            Reply::Detail(
                "selected".into(),
                signature.clone(),
                Err(anyhow!("temporary disconnect")),
            ),
        );
        assert_ne!(app.detail_key, signature);
        let (retry_id, retry_at) = app.detail_retry.as_ref().unwrap();
        assert_eq!(retry_id, "selected");
        assert!(*retry_at > Instant::now());
        handle_reply(
            &mut app,
            Reply::Query(
                0,
                Ok((
                    json!({"items":[{"id":"selected","endedAt":1}],"total":1}),
                    json!({"running":true,"port":8080}),
                )),
            ),
        );
        assert!(app.detail_retry.is_none());
        assert_ne!(app.detail_key, detail_signature(&app.flows[0]));
    }

    #[test]
    fn mac_delete_requests_confirmation_and_escape_preserves_capture() {
        let client = Client::new(
            &crate::client::Runtime {
                api_version: 1,
                session: "test".into(),
                endpoint: "http://127.0.0.1:1".into(),
                token: String::new(),
                read_token: String::new(),
                proxy_port: 8888,
                instance_id: "test".into(),
            },
            1,
        )
        .unwrap();
        let mut app = App::new("dark", true, Some(false));
        app.flows = vec![json!({"id":"capture"})];
        app.query_pending = true;
        let mut jobs = JoinSet::new();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &client,
            &mut jobs,
        )
        .unwrap();
        assert!(matches!(app.overlay, Overlay::Confirm(_)));
        assert!(jobs.is_empty());
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            &client,
            &mut jobs,
        )
        .unwrap();
        assert!(matches!(app.overlay, Overlay::None));
        assert_eq!(app.current().map(id), Some("capture"));
        assert!(jobs.is_empty());
    }

    #[test]
    fn binary_preview_preserves_bytes_and_caps_decoded_length() {
        let bytes: Vec<u8> = (0..BODY_LIMIT + 31).map(|i| (i % 256) as u8).collect();
        let flow = json!({"resBody":STANDARD.encode(&bytes),"resBodyEncoding":"base64"});
        assert_eq!(body_bytes(&flow, true), bytes[..BODY_LIMIT]);
        assert!(body_text(&flow, true, false).contains("Preview limited"));
    }

    #[test]
    fn multiline_unicode_cursor_edits_the_target_character() {
        let mut input = Input::new("Body", "éé\n漢字\nend");
        input.place(1, 2);
        input.key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));
        assert_eq!(input.value, "éé\n漢\nend");
        input.vertical(-1);
        input.insert("X");
        assert_eq!(input.value, "éXé\n漢\nend");
    }
}
