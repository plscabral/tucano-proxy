use crate::{
    client::fail,
    output::clean,
    tui::terminal::{auto_dark, safe, Guard, Palette},
};
use anyhow::{Context, Result};
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Position, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Wrap},
    Terminal, TerminalOptions, Viewport,
};
use std::{
    future::Future,
    io::{self, Write},
};

const STEPS: [&str; 4] = ["Ports", "Certificate", "Capture", "Ready"];
const WORDMARK: &str = "▀▀█▀▀ █   █ █▀▀▀▀ ▄▀▀▀▄ █▄  █ ▄▀▀▀▄\n  █   █   █ █     █   █ █ █ █ █   █\n  █   █   █ █     █▀▀▀█ █  ▀█ █   █\n  ▀   ▀▀▀▀▀ ▀▀▀▀▀ ▀   ▀ ▀   ▀ ▀▀▀▀▀";

pub(super) struct Wizard {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    events: EventStream,
    palette: Palette,
    session: String,
    step: usize,
    title: String,
    hint: String,
    options: Vec<(String, String)>,
    selected: usize,
    input: Option<String>,
    cursor: usize,
    error: String,
    details: String,
    expanded: bool,
    detail_scroll: u16,
    finished: bool,
    unicode: bool,
    _guard: Guard,
}

impl Wizard {
    pub fn new(session: &str, color: bool) -> Result<Self> {
        let guard = Guard::enter_inline()?;
        let palette = Palette::new(if color { auto_dark() } else { true }, Some(color));
        let height = crossterm::terminal::size()?
            .1
            .saturating_sub(1)
            .clamp(1, 25);
        let mut terminal = Terminal::with_options(
            CrosstermBackend::new(io::stdout()),
            TerminalOptions {
                viewport: Viewport::Inline(height),
            },
        )?;
        terminal.clear()?;
        let mut ui = Self {
            terminal,
            events: EventStream::new(),
            palette,
            session: clean(session),
            step: 0,
            title: "Checking your workspace".into(),
            hint: "Existing captures and certificates stay in place.".into(),
            options: Vec::new(),
            selected: 0,
            input: None,
            cursor: 0,
            error: String::new(),
            details: String::new(),
            expanded: false,
            detail_scroll: 0,
            finished: false,
            unicode: std::env::var("TERM").as_deref() != Ok("dumb"),
            _guard: guard,
        };
        ui.draw()?;
        Ok(ui)
    }

    pub fn step(&mut self, step: usize, details: impl Into<String>) {
        self.step = step;
        self.details = safe(&details.into());
        self.expanded = false;
        self.detail_scroll = 0;
    }

    pub fn finish(&mut self, title: &str, hint: &str) -> Result<()> {
        self.finished = true;
        self.busy(title, hint)
    }

    pub fn detail(&mut self, text: &str) {
        self.details.push('\n');
        self.details.push_str(&safe(text));
    }

    pub fn busy(&mut self, title: &str, hint: &str) -> Result<()> {
        self.title = title.into();
        self.hint = hint.into();
        self.options.clear();
        self.input = None;
        self.error.clear();
        self.draw()
    }

    pub async fn wait<T>(&mut self, future: impl Future<Output = Result<T>>) -> Result<T> {
        tokio::pin!(future);
        loop {
            tokio::select! {
                result = &mut future => return result,
                event = self.events.next() => { self.event(event)?; }
            }
        }
    }

    fn event(&mut self, event: Option<io::Result<Event>>) -> Result<Option<KeyEvent>> {
        match event.context("Terminal input closed")?? {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.code == KeyCode::Esc
                    || key.code == KeyCode::Char('q')
                    || (key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL))
                {
                    return Err(fail(
                        "setup_cancelled",
                        "Setup cancelled; no new completion was recorded",
                        2,
                    ));
                }
                let area = self.terminal.get_frame().area();
                if area.width < 37 || area.height < 15 {
                    return Ok(None);
                }
                if key.code == KeyCode::Char('d') && !self.details.is_empty() {
                    self.expanded = !self.expanded;
                    self.detail_scroll = 0;
                    self.draw()?;
                    return Ok(None);
                }
                if self.expanded {
                    match key.code {
                        KeyCode::Down | KeyCode::PageDown => {
                            self.detail_scroll = self.detail_scroll.saturating_add(1)
                        }
                        KeyCode::Up | KeyCode::PageUp => {
                            self.detail_scroll = self.detail_scroll.saturating_sub(1)
                        }
                        _ => return Ok(None),
                    }
                    self.draw()?;
                    return Ok(None);
                }
                Ok(Some(key))
            }
            Event::Paste(value) if self.input.is_some() => {
                if value.len() <= 5 && value.bytes().all(|byte| byte.is_ascii_digit()) {
                    self.cursor = value.len();
                    self.input = Some(value);
                    self.error.clear();
                    self.draw()?;
                }
                Ok(None)
            }
            Event::Resize(_, _) => {
                self.draw()?;
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    async fn key(&mut self) -> Result<KeyEvent> {
        loop {
            let event = self.events.next().await;
            if let Some(key) = self.event(event)? {
                return Ok(key);
            }
        }
    }

    pub async fn choose(
        &mut self,
        title: &str,
        hint: &str,
        options: &[(&str, &str)],
    ) -> Result<usize> {
        self.title = title.into();
        self.hint = hint.into();
        self.options = options
            .iter()
            .map(|(label, detail)| (label.to_string(), detail.to_string()))
            .collect();
        self.selected = 0;
        self.input = None;
        self.error.clear();
        self.expanded = false;
        loop {
            self.draw()?;
            match self.key().await?.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    self.selected = (self.selected + options.len() - 1) % options.len()
                }
                KeyCode::Down | KeyCode::Tab | KeyCode::Char('j') => {
                    self.selected = (self.selected + 1) % options.len()
                }
                KeyCode::Char(ch @ '1'..='9') if (ch as usize - '1' as usize) < options.len() => {
                    self.selected = ch as usize - '1' as usize
                }
                KeyCode::Enter if !self.expanded => return Ok(self.selected),
                _ => {}
            }
        }
    }

    pub async fn port(&mut self, title: &str, default: u16, excluded: Option<u16>) -> Result<u16> {
        self.title = title.into();
        self.hint = "Choose an unused local port between 1024 and 65535.".into();
        self.options.clear();
        self.input = Some(default.to_string());
        self.cursor = self.input.as_ref().unwrap().len();
        self.error.clear();
        self.expanded = false;
        loop {
            self.draw()?;
            let key = self.key().await?;
            if self.expanded {
                continue;
            }
            let input = self.input.as_mut().unwrap();
            match key.code {
                KeyCode::Enter => {
                    if let Ok(port) = input.parse::<u16>() {
                        if port >= 1024
                            && Some(port) != excluded
                            && std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                                .is_ok()
                        {
                            return Ok(port);
                        }
                    }
                    self.error = "Port unavailable. Choose another local port.".into();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    input.clear();
                    self.cursor = 0;
                    self.error.clear();
                }
                KeyCode::Char(ch) if ch.is_ascii_digit() && input.len() < 5 => {
                    input.insert(self.cursor, ch);
                    self.cursor += 1;
                    self.error.clear();
                }
                KeyCode::Backspace if self.cursor > 0 => {
                    self.cursor -= 1;
                    input.remove(self.cursor);
                    self.error.clear();
                }
                KeyCode::Delete if self.cursor < input.len() => {
                    input.remove(self.cursor);
                    self.error.clear();
                }
                KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
                KeyCode::Right => self.cursor = (self.cursor + 1).min(input.len()),
                KeyCode::Home => self.cursor = 0,
                KeyCode::End => self.cursor = input.len(),
                _ => {}
            }
        }
    }

    fn draw(&mut self) -> Result<()> {
        let p = self.palette;
        let dim = Style::default().fg(p.dim);
        let accent = Style::default().fg(p.accent).add_modifier(Modifier::BOLD);
        let bold = Style::default().add_modifier(Modifier::BOLD);
        let unicode = self.unicode;
        self.terminal.draw(|frame| {
            let viewport = frame.area();
            let area = Rect::new(
                viewport.x + 1,
                viewport.y,
                viewport.width.saturating_sub(2).min(98),
                viewport.height,
            );
            if area.width < 35 || area.height < 15 {
                frame.render_widget(
                    Paragraph::new(
                        "TUCANO PROXY\nEnlarge the terminal to continue.\nEsc cancels safely.",
                    ),
                    area,
                );
                return;
            }
            let large = area.width >= 76 && area.height >= 23;
            let header_height = if large { 9 } else { 4 };
            let header = Rect::new(area.x, area.y, area.width, header_height);
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(if unicode {
                    BorderType::Rounded
                } else {
                    BorderType::Plain
                })
                .border_style(dim)
                .title(Line::from(Span::styled(
                    format!(" tucano proxy v{} ", env!("CARGO_PKG_VERSION")),
                    accent,
                )));
            let block = if unicode {
                block
            } else {
                block.border_set(ratatui::symbols::border::Set {
                    top_left: "+",
                    top_right: "+",
                    bottom_left: "+",
                    bottom_right: "+",
                    vertical_left: "|",
                    vertical_right: "|",
                    horizontal_top: "-",
                    horizontal_bottom: "-",
                })
            };
            frame.render_widget(block, header);
            if large {
                let mark = if unicode { WORDMARK } else { "T U C A N O" };
                frame.render_widget(
                    Paragraph::new(mark).style(accent),
                    Rect::new(area.x + 3, area.y + 2, 35, 4),
                );
                frame.render_widget(
                    Paragraph::new("P R O X Y").style(dim),
                    Rect::new(area.x + 14, area.y + 7, 14, 1),
                );
                let right = Rect::new(area.x + 43, area.y + 2, area.width - 46, 6);
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::from(Span::styled("Welcome to your workspace", bold)),
                        Line::from(Span::styled("Local HTTP & HTTPS inspection", dim)),
                        Line::default(),
                        Line::from(vec![
                            Span::styled("Session   ", dim),
                            Span::raw(&self.session),
                        ]),
                        Line::from(vec![
                            Span::styled("Network   ", dim),
                            Span::raw("127.0.0.1 only"),
                        ]),
                        Line::from(Span::styled("Existing captures stay in place.", dim)),
                    ]),
                    right,
                );
            } else {
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::from(vec![
                            Span::styled("FIRST-USE SETUP  ", bold),
                            Span::styled(&self.session, dim),
                        ]),
                        Line::from(Span::styled("Local capture. Existing data preserved.", dim)),
                    ]),
                    Rect::new(area.x + 2, area.y + 1, area.width - 4, 2),
                );
            }
            let progress_y = area.y + header_height + 1;
            let progress = if area.width >= 64 {
                Line::from(
                    STEPS
                        .iter()
                        .enumerate()
                        .flat_map(|(index, label)| {
                            [
                                Span::styled(
                                    format!("{:02} {label}", index + 1),
                                    if index == self.step { accent } else { dim },
                                ),
                                Span::styled(if index == 3 { "" } else { "    " }, dim),
                            ]
                        })
                        .collect::<Vec<_>>(),
                )
            } else {
                Line::from(Span::styled(
                    format!("{:02} / 04  {}", self.step + 1, STEPS[self.step]),
                    accent,
                ))
            };
            frame.render_widget(
                progress,
                Rect::new(area.x + 2, progress_y, area.width - 4, 1),
            );
            let body_y = progress_y + 2;
            let footer_y = area.bottom().saturating_sub(1);
            let body = Rect::new(
                area.x + 2,
                body_y,
                area.width - 4,
                footer_y.saturating_sub(body_y),
            );
            if self.expanded {
                let details = Paragraph::new(format!("Session details\n\n{}", self.details))
                    .wrap(Wrap { trim: false });
                self.detail_scroll = self.detail_scroll.min(
                    details
                        .line_count(body.width)
                        .saturating_sub(body.height as usize)
                        .min(u16::MAX as usize) as u16,
                );
                frame.render_widget(details.scroll((self.detail_scroll, 0)), body);
            } else {
                frame.render_widget(
                    Paragraph::new(self.title.as_str()).style(bold),
                    Rect::new(body.x, body.y, body.width, 1),
                );
                frame.render_widget(
                    Paragraph::new(self.hint.as_str())
                        .style(dim)
                        .wrap(Wrap { trim: true }),
                    Rect::new(body.x, body.y + 1, body.width, 2),
                );
                let choices_y = body.y + if large { 4 } else { 3 };
                if let Some(input) = &self.input {
                    frame.render_widget(
                        Line::from(vec![
                            Span::styled(if unicode { "› " } else { "> " }, accent),
                            Span::styled(input, bold),
                        ]),
                        Rect::new(body.x, choices_y, body.width, 1),
                    );
                    frame.set_cursor_position(Position::new(
                        body.x + 2 + self.cursor as u16,
                        choices_y,
                    ));
                } else {
                    for (index, (label, detail)) in self.options.iter().enumerate() {
                        let y = choices_y + index as u16 * if large { 2 } else { 1 };
                        if y >= footer_y {
                            break;
                        }
                        let selected = self.selected == index;
                        frame.render_widget(
                            Line::from(vec![
                                Span::styled(
                                    if selected {
                                        if unicode {
                                            "› "
                                        } else {
                                            "> "
                                        }
                                    } else {
                                        "  "
                                    },
                                    accent,
                                ),
                                Span::styled(
                                    label,
                                    if selected { accent } else { Style::default() },
                                ),
                            ]),
                            Rect::new(body.x, y, body.width, 1),
                        );
                        if large && y + 1 < footer_y {
                            frame.render_widget(
                                Paragraph::new(detail.as_str()).style(dim),
                                Rect::new(body.x + 2, y + 1, body.width - 2, 1),
                            );
                        }
                    }
                }
                if !self.error.is_empty() {
                    frame.render_widget(
                        Paragraph::new(self.error.as_str()).style(Style::default().fg(p.bad)),
                        Rect::new(body.x, footer_y.saturating_sub(2), body.width, 1),
                    );
                }
            }
            let keys = if self.finished {
                "Run setup again whenever you need to change these choices."
            } else if self.expanded {
                "Up/Down scroll   d close   Esc cancel"
            } else if area.width < 64 && self.input.is_some() {
                "Enter  Ctrl+U clear  d info  Esc"
            } else if area.width < 64 && !self.options.is_empty() {
                "j/k select  Enter  d info  Esc"
            } else if self.input.is_some() {
                "Enter confirm   Ctrl+U clear   d details   Esc cancel"
            } else if self.options.is_empty() {
                "Esc cancel"
            } else if unicode {
                "↑↓ select   Enter confirm   d details   Esc cancel"
            } else {
                "j/k select   Enter confirm   d details   Esc cancel"
            };
            frame.render_widget(
                Paragraph::new(keys).style(dim),
                Rect::new(area.x + 2, footer_y, area.width - 4, 1),
            );
        })?;
        Ok(())
    }
}

impl Drop for Wizard {
    fn drop(&mut self) {
        let area = self.terminal.get_frame().area();
        let _ = self
            .terminal
            .set_cursor_position(Position::new(0, area.bottom().saturating_sub(1)));
        let _ = writeln!(self.terminal.backend_mut(), "\r");
    }
}
