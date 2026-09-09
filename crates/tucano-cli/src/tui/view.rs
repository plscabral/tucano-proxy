use super::*;
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Cell, Clear, Paragraph, Row, Table, Tabs, Wrap},
    Frame,
};
use unicode_width::UnicodeWidthStr;

fn block<'a>(title: impl Into<Line<'a>>, palette: Palette, focus: bool) -> Block<'a> {
    let ascii = ratatui::symbols::border::Set {
        top_left: "+",
        top_right: "+",
        bottom_left: "+",
        bottom_right: "+",
        vertical_left: "|",
        vertical_right: "|",
        horizontal_top: "-",
        horizontal_bottom: "-",
    };
    Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_type(BorderType::Plain)
        .border_set(ascii)
        .border_style(Style::default().fg(if focus { palette.accent } else { palette.dim }))
        .style(palette.base())
}
fn popup(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(2));
    let height = height.min(area.height.saturating_sub(2));
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}
fn selected_style(p: Palette) -> Style {
    if p.mono {
        p.base().add_modifier(Modifier::REVERSED | Modifier::BOLD)
    } else {
        p.base().bg(p.selection).add_modifier(Modifier::BOLD)
    }
}
pub(super) fn draw(frame: &mut Frame, app: &mut App, image: bool) {
    let area = frame.area();
    let p = app.palette;
    frame.render_widget(Block::default().style(p.base()), area);
    if area.width < 32 || area.height < 12 {
        frame.render_widget(Paragraph::new("TUCANO PROXY\n\nIncrease terminal to at least 32 x 12.\n\nq quits without stopping capture.").style(p.base()),area);
        return;
    }
    if let Overlay::Help(page) = app.overlay {
        render_help(frame, app, area, page);
        return;
    }
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(2),
            Constraint::Min(4),
            Constraint::Length(2),
        ])
        .split(area);
    let logo_prefix = if image { "      " } else { " (o)> " };
    let header = vec![
        Line::from(vec![
            Span::styled(
                format!("{logo_prefix}TUCANO PROXY"),
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  /  terminal workspace", Style::default().fg(p.dim)),
        ]),
        Line::from(vec![
            Span::raw("      "),
            Span::styled(
                if app.connected {
                    if app.capture {
                        "CAPTURE ON"
                    } else {
                        "CAPTURE OFF"
                    }
                } else {
                    "DISCONNECTED"
                },
                Style::default().fg(if app.connected {
                    if app.capture {
                        p.good
                    } else {
                        p.dim
                    }
                } else {
                    p.bad
                }),
            ),
            Span::raw(format!(
                "  :{}  |  follow {}  |  {} captures  |  {} selected",
                app.port,
                if app.follow { "on" } else { "paused" },
                app.total,
                app.selected_ids.len()
            )),
        ]),
    ];
    frame.render_widget(Paragraph::new(header).style(p.base()), layout[0]);
    if !app.follow {
        frame.render_widget(
            Paragraph::new(
                "      Viewport paused; F5 refreshes this page. Capture and totals stay live.",
            )
            .style(Style::default().fg(p.dim)),
            Rect::new(layout[0].x, layout[0].y + 2, layout[0].width, 1),
        );
    }
    let filter = if app.filter.is_empty() {
        "All traffic".into()
    } else {
        single(&app.filter)
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(" / ", Style::default().fg(p.accent)),
                Span::raw(filter),
            ]),
            Line::from(Span::styled(
                format!(
                    "   sort: {} {}   range: {}-{} / {}   [ ] page   s sort   S direction",
                    SORTS[app.sort],
                    if app.descending {
                        "descending"
                    } else {
                        "ascending"
                    },
                    if app.total == 0 { 0 } else { app.offset + 1 },
                    app.offset + app.flows.len(),
                    app.total
                ),
                Style::default().fg(p.dim),
            )),
        ]),
        layout[1],
    );
    let content = layout[2];
    if app.inspector_only {
        app.table_area = Rect::default();
        render_inspector(frame, app, content);
    } else if content.width >= 120 {
        let split = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(53), Constraint::Percentage(47)])
            .split(content);
        render_table(frame, app, split[0]);
        render_inspector(frame, app, split[1]);
    } else if content.height >= 20 {
        let split = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(44), Constraint::Percentage(56)])
            .split(content);
        render_table(frame, app, split[0]);
        render_inspector(frame, app, split[1]);
    } else if app.inspector_focus {
        app.table_area = Rect::default();
        render_inspector(frame, app, content);
    } else {
        app.inspector_area = Rect::default();
        app.tabs_area = Rect::default();
        render_table(frame, app, content);
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                single(&app.status),
                Style::default().fg(if app.connected { p.dim } else { p.bad }),
            )),
            Line::from(vec![
                Span::styled(
                    " ? help ",
                    Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
                ),
                Span::raw(
                    " / filter  D clear all  f follow  c capture  C compose  e export  q quit",
                ),
            ]),
        ]),
        layout[3],
    );
    render_overlay(frame, app, area);
}
fn render_table(frame: &mut Frame, app: &mut App, area: Rect) {
    app.table_area = area;
    let p = app.palette;
    let visible: Vec<usize> = (0..COLUMNS.len())
        .filter(|&i| {
            app.columns[i]
                && match i {
                    0 => area.width >= 58,
                    3 => area.width >= 60,
                    5 => area.width >= 76,
                    6 => area.width >= 92,
                    7 => area.width >= 104,
                    _ => true,
                }
        })
        .collect();
    let visible = if visible.is_empty() { vec![4] } else { visible };
    let widths: Vec<Constraint> = visible
        .iter()
        .map(|i| match i {
            0 => Constraint::Length(5),
            1 => Constraint::Length(7),
            2 => Constraint::Length(6),
            3 => Constraint::Percentage(26),
            4 => Constraint::Min(8),
            5 => Constraint::Length(9),
            6 => Constraint::Length(8),
            _ => Constraint::Length(9),
        })
        .collect();
    let rows: Vec<Row> = app
        .flows
        .iter()
        .map(|flow| {
            let values = [
                printable(flow, "index"),
                printable(flow, "method"),
                printable(flow, "status"),
                printable(flow, "host"),
                printable(flow, "path"),
                flow["durationMs"]
                    .as_f64()
                    .map(|v| format!("{v:.0}ms"))
                    .unwrap_or_else(|| "pending".into()),
                format_size(number(flow, "resSize")),
                printable(flow, "mark"),
            ];
            let marked = app.selected_ids.contains(id(flow));
            let cells = visible
                .iter()
                .enumerate()
                .map(|(column, &i)| {
                    let value = if column == 0 {
                        format!("{}{}", if marked { "*" } else { " " }, values[i])
                    } else {
                        values[i].clone()
                    };
                    let style = if i == 2 {
                        Style::default().fg(if number(flow, "status") >= 400 {
                            p.bad
                        } else if number(flow, "status") >= 200 {
                            p.good
                        } else {
                            p.dim
                        })
                    } else {
                        Style::default()
                    };
                    Cell::from(value).style(style)
                })
                .collect::<Vec<_>>();
            Row::new(cells).style(if marked {
                Style::default().fg(p.accent)
            } else {
                p.base()
            })
        })
        .collect();
    app.table.select(if app.flows.is_empty() {
        None
    } else {
        Some(app.selected)
    });
    let table = Table::new(rows, widths)
        .header(
            Row::new(visible.iter().map(|&i| Cell::from(COLUMNS[i])))
                .style(Style::default().fg(p.dim))
                .bottom_margin(0),
        )
        .block(block(" Captures ", p, !app.inspector_focus))
        .row_highlight_style(selected_style(p))
        .highlight_symbol(">")
        .column_spacing(1);
    frame.render_stateful_widget(table, area, &mut app.table);
    if app.flows.is_empty() {
        let inner = Rect::new(
            area.x + 2,
            area.y + 3,
            area.width.saturating_sub(4),
            area.height.saturating_sub(4),
        );
        let message = if !app.connected {
            "Connecting to session...\nYou can still open help (?) or quit (q)."
        } else if !app.filter.is_empty() {
            "No captures match this filter.\nPress / to edit or clear it."
        } else if app.capture {
            "Waiting for traffic.\nConfigure your client to use the proxy port above.\nC composes a request; ? shows all controls."
        } else {
            "Capture is stopped.\nc starts the listener without changing OS proxy settings.\nC composes a request; ? shows all controls."
        };
        frame.render_widget(
            Paragraph::new(message)
                .style(Style::default().fg(p.dim))
                .wrap(Wrap { trim: false }),
            inner,
        );
    }
}
fn format_size(n: u64) -> String {
    if n >= 1_048_576 {
        format!("{:.1}MiB", n as f64 / 1_048_576.0)
    } else if n >= 1024 {
        format!("{:.1}KiB", n as f64 / 1024.0)
    } else {
        format!("{n}B")
    }
}
fn render_inspector(frame: &mut Frame, app: &mut App, area: Rect) {
    app.inspector_area = area;
    let p = app.palette;
    let title = format!(
        " Inspector / {}{} ",
        if app.response { "response" } else { "request" },
        if app.detail_pending { " / loading" } else { "" }
    );
    let outer = block(title, p, app.inspector_focus);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);
    if inner.height < 3 || inner.width == 0 {
        return;
    }
    let mode = if app.tab == 2 {
        let kind = app
            .selected_detail()
            .map(|flow| preview::kind(flow, app.response).label())
            .unwrap_or("Body");
        format!("J {} {kind}", if app.pretty { "Preview" } else { "Source" })
    } else {
        TABS[app.tab].to_owned()
    };
    let hints = Paragraph::new(format!(
        "b req/res | {mode} | w {} | 1-7 tabs{}",
        if app.wrap { "Wrap" } else { "No-wrap" },
        if app.wrap { "" } else { " | Shift arrows pan" }
    ))
    .style(Style::default().fg(p.dim))
    .wrap(Wrap { trim: false });
    let hint_height = hints
        .line_count(inner.width)
        .max(1)
        .min(inner.height.saturating_sub(2) as usize) as u16;
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(hint_height),
            Constraint::Min(1),
        ])
        .split(inner);
    app.tabs_area = parts[0];
    if inner.width >= 62 {
        frame.render_widget(
            Tabs::new(TABS.to_vec())
                .select(app.tab)
                .padding(" ", " ")
                .divider(" ")
                .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD)),
            parts[0],
        );
    } else {
        frame.render_widget(
            Paragraph::new(format!(
                "< {} ({}/{}) >",
                TABS[app.tab],
                app.tab + 1,
                TABS.len()
            ))
            .style(Style::default().fg(p.accent)),
            parts[0],
        );
    }
    frame.render_widget(hints, parts[1]);
    let key = format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        app.selected_detail().map(id).unwrap_or(""),
        app.detail_key,
        app.tab,
        app.response,
        app.pretty,
        app.detail_pending,
        parts[2].width,
        app.wrap
    );
    if app.preview.as_ref().map(|(cached, _, _)| cached) != Some(&key) {
        let width = if app.wrap {
            parts[2].width as usize
        } else {
            BODY_LIMIT
        };
        let content = app.selected_detail().map(|flow| document(flow, app.tab, app.response, app.pretty, width))
            .unwrap_or_else(|| if app.detail_pending {
                "Loading selected capture...".into()
            } else {
                "Select a capture to inspect it.\nTab switches keyboard focus.\nEnter expands this inspector.".into()
            });
        let paragraph = inspector_paragraph(&content, app.wrap);
        let lines = paragraph.line_count(parts[2].width);
        app.preview = Some((key, content, lines));
    }
    let (content, lines) = app
        .preview
        .as_ref()
        .map(|(_, content, lines)| (content.as_str(), *lines))
        .unwrap_or(("", 0));
    let scroll = if matches!(app.overlay, Overlay::None) {
        app.scroll = app.scroll.min(
            lines
                .saturating_sub(parts[2].height as usize)
                .min(u16::MAX as usize) as u16,
        );
        app.scroll
    } else {
        0
    };
    frame.render_widget(
        inspector_paragraph(content, app.wrap)
            .scroll((scroll, if app.wrap { 0 } else { app.horizontal }))
            .style(p.base()),
        parts[2],
    );
}

fn inspector_paragraph(content: &str, wrap: bool) -> Paragraph<'_> {
    let paragraph = Paragraph::new(content);
    if wrap {
        paragraph.wrap(Wrap { trim: false })
    } else {
        paragraph
    }
}
fn document(flow: &Value, tab: usize, response: bool, pretty: bool, width: usize) -> String {
    match tab {
        0=>format!("{} {}\n\nStatus     {} {}\nProtocol   {}\nStarted    {} (Unix ms)\nEnded      {} (Unix ms)\nDuration   {} ms\nRequest    {}\nResponse   {}\nClient     {}\nMark       {}\n\n{}{}",single(text(flow,"method")),single(&url(flow)),printable(flow,"status"),printable(flow,"statusText"),printable(flow,"httpVersion"),printable(flow,"startedAt"),printable(flow,"endedAt"),printable(flow,"durationMs"),format_size(number(flow,"reqSize")),format_size(number(flow,"resSize")),printable(flow,"clientApp"),printable(flow,"mark"),if text(flow,"error").is_empty(){String::new()}else{format!("Error: {}\n\n",safe(text(flow,"error")))},safe(text(flow,"note"))),
        1=>{let result=headers(flow,response);if result.is_empty(){"[No captured headers]".into()}else{result}},
        2=>if pretty { preview::render(flow, response, width) } else { body_text(flow, response, false) },
        3=>format!("{}\n{}\n\n{}",if response{format!("{} {} {}",printable(flow,"httpVersion"),printable(flow,"status"),printable(flow,"statusText"))}else{format!("{} {} {}",printable(flow,"method"),printable(flow,"path"),printable(flow,"httpVersion"))},headers(flow,response),body_text(flow,response,false)),
        4=>{
            let bytes=body_bytes(flow,response); let mut out=String::from("OFFSET    HEX BYTES                                        ASCII\n");
            use std::fmt::Write;
            for (i,chunk) in bytes.chunks(16).enumerate(){let _=write!(out,"{:08x}  ",i*16);for byte in chunk{let _=write!(out,"{byte:02x} ");}for _ in chunk.len()..16{out.push_str("   ");}out.push(' ');for &byte in chunk{out.push(if (32..127).contains(&byte){byte as char}else{'.'});}out.push('\n');}
            if bytes.is_empty(){out.push_str("[No captured body]");}out
        },
        5=>format!("CAPTURE TIMELINE\n\nStarted at      {} Unix ms\nCompleted at    {} Unix ms\nTotal elapsed   {} ms\n\nRequest bytes   {}\nResponse bytes  {}\n\n{}\n\nDNS, TCP and TLS phase timings are not recorded.\nTotal duration is measured by the capture engine.",printable(flow,"startedAt"),printable(flow,"endedAt"),printable(flow,"durationMs"),printable(flow,"reqSize"),printable(flow,"resSize"),if flow["endedAt"].is_null(){"This request is still pending."}else{"This capture is complete."}),
        _=>format!("NOTE\n\nn edits this note; Ctrl+Enter saves.\n\n{}\n\nMARK\n\nm changes the persistent mark.\n\n{}",safe(text(flow,"note")),printable(flow,"mark"))
    }
}
pub(super) const HELP_TITLES: [&str; 5] = ["Captures", "Inspect", "Compose", "Filter", "About"];

fn render_help(frame: &mut Frame, app: &mut App, area: Rect, page: usize) {
    let p = app.palette;
    let rect = popup(area, 98, 31);
    let outer = block(" Tucano / Help ", p, true);
    let inner = outer.inner(rect);
    frame.render_widget(outer, rect);
    let inner = inner.inner(ratatui::layout::Margin::new(2, 1));
    let compact = inner.width < 70;
    let parts = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(if inner.height < 12 {
            0
        } else if compact {
            2
        } else {
            3
        }),
        Constraint::Min(1),
        Constraint::Length(2),
    ])
    .split(inner);
    let accent = p.base().fg(p.accent).add_modifier(Modifier::BOLD);
    if compact {
        frame.render_widget(
            Paragraph::new(format!("{} / 5   {}", page + 1, HELP_TITLES[page])).style(accent),
            parts[0],
        );
    } else {
        frame.render_widget(
            Tabs::new(
                HELP_TITLES
                    .iter()
                    .enumerate()
                    .map(|(i, title)| format!("{} {title}", i + 1)),
            )
            .select(page)
            .divider("  ")
            .style(p.base().fg(p.dim))
            .highlight_style(selected_style(p).fg(p.accent)),
            parts[0],
        );
    }
    let (intro, rows, note): (&str, &[(&str, &str)], &str) = match page {
        0 => (
            "Close help with Esc before using these shortcuts.",
            &[
                ("D  (Shift+d)", "Clear ALL captures, including filtered-out traffic"),
                ("d / Delete", "Delete selected captures (Mac Delete also works)"),
                ("Space / a", "Toggle selection / select the current page"),
                ("Esc", "Clear selection"),
                ("f", "Follow newest / pause following"),
                ("c", "Start / stop the capture listener"),
                ("e", "Export all captures, or only the selected ones"),
                ("q / Ctrl+C", "Leave TUI; keep the service and captures"),
            ],
            "Deletion asks for y to confirm. Esc cancels.\nThe listener alone does not enable the OS proxy.",
        ),
        1 => (
            "Move through traffic and inspect a request.",
            &[
                ("j/k / Up/Down", "Move selection or scroll the focused inspector"),
                ("Tab / Enter", "Switch focus / expand or restore the inspector"),
                ("Home/End / g/G", "Jump to the first / last row or inspector line"),
                ("PageUp/PageDown", "Scroll one screen; mouse wheel scrolls under pointer"),
                ("1-7 / Left/Right", "Overview, headers, body, raw, hex, timing, note"),
                ("b / J", "Request or response / body preview or source"),
                ("w", "Toggle line wrapping"),
                ("Shift+Left/Right", "Pan horizontally when wrapping is off"),
                ("n / m / x", "Edit note / set mark / compare two selected captures"),
            ],
            "Empty notes or marks remove them. Select with Space before comparing.",
        ),
        2 => (
            "Create, edit and replay requests.",
            &[
                ("C  (Shift+c)", "Create a request"),
                ("r / R", "Edit captured request / replay original immediately"),
                ("Tab / Shift+Tab", "Next / previous editor field"),
                ("Ctrl+Enter / F5", "Send from composer; Ctrl+Enter also saves notes"),
                ("Enter", "Insert a line in body or headers; apply single-line fields"),
                ("Left/Right", "Move the text cursor"),
                ("Home / End", "Start / end of the current line"),
                ("Ctrl+U", "Clear the current field; paste is supported"),
                ("Esc", "Close editor or stop waiting for a running request"),
            ],
            "Stopping the wait cannot retract a request already sent.\nComposer body input is limited to 128 KiB.",
        ),
        3 => (
            "Find traffic and arrange the capture table.",
            &[
                ("/", "Edit filter; an empty filter shows all captures"),
                ("host:api", "Match host; free text also searches captures"),
                ("method:POST", "Match HTTP method"),
                ("status:>=400", "Filter status; duration:>100 filters milliseconds"),
                ("path:/v1", "Match path; mime:json and scheme:https are supported"),
                ("s / S", "Cycle sort field / reverse direction"),
                ("[ / ]", "Previous / next page (250 summaries per page)"),
                ("v", "Choose visible columns"),
                ("F5", "Refresh summaries and the selected body"),
            ],
            "Combine filter rules with spaces. Narrow terminals hide extra columns.",
        ),
        _ => (
            "Appearance, capture settings and safety.",
            &[
                (",", "Open settings: theme, privacy, retention and TLS rules"),
                ("Theme", "Auto detects terminal background; dark / light are explicit"),
                ("NO_COLOR", "Disable color and graphics; no special fonts required"),
                ("Private mode", "Enabling it clears retained captures"),
                ("TLS / OS proxy", "Settings do not install a CA or change OS proxy routing"),
                ("Body preview", "Text only; no scripts, CSS rendering or network fetches"),
                ("Source / Raw", "Keep markup; malformed previews fall back to source"),
                ("Exports", "HAR, JSON, cURL or SQLite; files may contain credentials"),
            ],
            "Terminal control sequences are removed from captured content.\nNew export files are owner-only on Unix.",
        ),
    };
    frame.render_widget(
        Paragraph::new(intro)
            .wrap(Wrap { trim: false })
            .style(p.base().fg(p.dim)),
        parts[1],
    );
    let mut lines = Vec::with_capacity(rows.len() * 3 + 3);
    for &(key, description) in rows {
        let key_style = if page == 0 && key.starts_with('D') {
            accent.fg(p.bad)
        } else {
            accent
        };
        if compact {
            lines.push(Line::styled(key, key_style));
            lines.push(Line::from(description));
        } else {
            lines.push(Line::from(vec![
                Span::styled(format!("{key:<21}"), key_style),
                Span::raw(description),
            ]));
        }
        lines.push(Line::from(""));
    }
    lines.extend(
        note.lines()
            .map(|line| Line::styled(line, p.base().fg(p.dim))),
    );
    let content = Paragraph::new(lines)
        .style(p.base())
        .wrap(Wrap { trim: false });
    let count = content.line_count(parts[2].width);
    let max_scroll = count
        .saturating_sub(parts[2].height as usize)
        .min(u16::MAX as usize) as u16;
    app.scroll = app.scroll.min(max_scroll);
    frame.render_widget(content.scroll((app.scroll, 0)), parts[2]);
    let navigation = if inner.width < 40 {
        "1-5 section  Esc close"
    } else if compact {
        "Left/Right: section  Esc: close"
    } else {
        "Left/Right or Tab  section    1-5  jump    Esc / ?  close"
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(navigation, accent),
            Line::styled(
                if max_scroll > 0 {
                    format!("Up/Down scroll   {}/{}", app.scroll + 1, max_scroll + 1)
                } else {
                    "Close help to use shortcuts.".into()
                },
                p.base().fg(p.dim),
            ),
        ]),
        parts[3],
    );
}

fn render_overlay(frame: &mut Frame, app: &mut App, area: Rect) {
    let p = app.palette;
    app.editor_hits.clear();
    match &app.overlay {
        Overlay::None => {}
        Overlay::Help(_) => {}
        Overlay::Settings => {
            let rect = popup(area, 78, 22);
            frame.render_widget(Clear, rect);
            let text=format!("APPEARANCE\n\n  a Auto    d Dark    l Light\n  Current: {}{}\n\nCAPTURE SETTINGS{}\n\n  p  Private mode: {} (enabling clears retained captures)\n  k  Retention: {} captures (0 = unlimited)\n  s  TLS interception rules: {}\n\nPrivate mode, retention and TLS rules are service settings.\nTheme is local to this terminal. No OS proxy or CA trust\nsettings are changed here.\n\nEsc closes settings.",app.theme,if p.mono{" (monochrome)"}else{""},if app.settings_pending{" / loading"}else{""},if app.private{"on"}else{"off"},app.keep_limit,printable(&app.ssl,"mode"));
            frame.render_widget(
                Paragraph::new(text)
                    .block(block(" Settings ", p, true))
                    .wrap(Wrap { trim: false }),
                rect,
            );
        }
        Overlay::Columns(selected) => {
            let rect = popup(area, 50, 15);
            frame.render_widget(Clear, rect);
            let mut lines = vec![
                Line::from("Up/Down selects; Space toggles; Enter closes."),
                Line::from(""),
            ];
            for (i, label) in COLUMNS.iter().enumerate() {
                lines.push(Line::styled(
                    format!(
                        " {} [{}] {label}",
                        if i == *selected { ">" } else { " " },
                        if app.columns[i] { "x" } else { " " }
                    ),
                    if i == *selected {
                        selected_style(p)
                    } else {
                        p.base()
                    },
                ));
            }
            lines.push(Line::from(""));
            lines.push(Line::from(
                "Extra columns hide automatically in narrow layouts.",
            ));
            frame.render_widget(
                Paragraph::new(lines).block(block(" Capture columns ", p, true)),
                rect,
            );
        }
        Overlay::Confirm(confirm) => {
            let rect = popup(area, 76, 9);
            frame.render_widget(Clear, rect);
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(Span::styled(
                        single(&confirm.title),
                        Style::default().fg(p.bad).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(""),
                    Line::from("y confirms. n or Esc cancels."),
                    Line::from("This action cannot be undone."),
                ])
                .wrap(Wrap { trim: false })
                .block(block(" Confirm action ", p, true)),
                rect,
            );
        }
        Overlay::Editor(editor) => {
            app.editor_hits = render_editor(frame, editor, area, p, app.compose_task.is_some())
        }
        Overlay::Diff(a, b) => {
            let rect = popup(area, area.width, area.height);
            frame.render_widget(Clear, rect);
            let outer = block(
                format!(
                    " Compare {} / {} / {} / b switches side / Esc closes ",
                    printable(a, "index"),
                    printable(b, "index"),
                    if app.response { "response" } else { "request" }
                ),
                p,
                true,
            );
            let inner = outer.inner(rect);
            frame.render_widget(outer, rect);
            let columns = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
                .split(inner);
            let left = format!(
                "{} {}\nStatus: {}\n{}\n\n{}",
                printable(a, "method"),
                single(&url(a)),
                printable(a, "status"),
                headers(a, app.response),
                body_text(a, app.response, app.pretty)
            );
            let right = format!(
                "{} {}\nStatus: {}\n{}\n\n{}",
                printable(b, "method"),
                single(&url(b)),
                printable(b, "status"),
                headers(b, app.response),
                body_text(b, app.response, app.pretty)
            );
            let left: Vec<_> = left.lines().collect();
            let right: Vec<_> = right.lines().collect();
            app.scroll = app.scroll.min(
                left.len()
                    .max(right.len())
                    .saturating_sub(inner.height as usize)
                    .min(u16::MAX as usize) as u16,
            );
            for (index, (lines, other)) in
                [(&left, &right), (&right, &left)].into_iter().enumerate()
            {
                let rendered: Vec<_> = lines
                    .iter()
                    .enumerate()
                    .skip(app.scroll as usize)
                    .take(inner.height as usize)
                    .map(|(i, line)| {
                        let changed = other.get(i) != Some(line);
                        Line::styled(
                            format!(
                                "{} {}",
                                if changed {
                                    if index == 0 {
                                        "-"
                                    } else {
                                        "+"
                                    }
                                } else {
                                    " "
                                },
                                line
                            ),
                            if changed {
                                Style::default().fg(if index == 0 { p.bad } else { p.good })
                            } else {
                                p.base()
                            },
                        )
                    })
                    .collect();
                frame.render_widget(Paragraph::new(rendered), columns[index]);
            }
        }
    }
}
fn render_editor(
    frame: &mut Frame,
    editor: &Editor,
    area: Rect,
    p: Palette,
    running: bool,
) -> Vec<(Rect, usize, usize)> {
    let compose = matches!(editor.kind, EditKind::Compose);
    let multiline = compose || matches!(editor.kind, EditKind::Note(_) | EditKind::Ssl);
    let height = if multiline {
        area.height.saturating_sub(2)
    } else if editor.fields.len() > 1 {
        13
    } else {
        9
    };
    let rect = popup(area, if compose { 112 } else { 88 }, height);
    frame.render_widget(Clear, rect);
    let title = match editor.kind {
        EditKind::Filter => " Filter captures ",
        EditKind::Note(_) => " Edit note ",
        EditKind::Mark(_) => " Mark captures ",
        EditKind::Export(_) => " Export captures ",
        EditKind::Compose => {
            if running {
                " Request composer / sending "
            } else {
                " Request composer "
            }
        }
        EditKind::KeepLimit => " Capture retention ",
        EditKind::Ssl => " TLS interception settings ",
    };
    let outer = block(title, p, true);
    let inner = outer.inner(rect);
    frame.render_widget(outer, rect);
    if inner.height < 2 {
        return Vec::new();
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(inner);
    let constraints: Vec<_> = if compose {
        vec![
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Percentage(35),
            Constraint::Min(3),
        ]
    } else {
        editor
            .fields
            .iter()
            .map(|_| {
                if multiline {
                    Constraint::Min(3)
                } else {
                    Constraint::Length(3)
                }
            })
            .collect()
    };
    let fields = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(chunks[0]);
    let compact = chunks[0].height < editor.fields.len() as u16 * 4;
    let mut hits = vec![(Rect::default(), 0, 0); editor.fields.len()];
    for (i, input) in editor.fields.iter().enumerate() {
        if compact && i != editor.focus {
            continue;
        }
        let field_area = if compact { chunks[0] } else { fields[i] };
        let field = block(
            format!(" {} ({}/{}) ", input.label, i + 1, editor.fields.len()),
            p,
            i == editor.focus,
        );
        let inside = field.inner(field_area);
        frame.render_widget(field, field_area);
        let before = &input.value[..input.cursor];
        let cursor_row = before.bytes().filter(|&b| b == b'\n').count();
        let current_line = before.rsplit('\n').next().unwrap_or("");
        let cursor_col = UnicodeWidthStr::width(current_line);
        let scroll_y = cursor_row.saturating_sub(inside.height.saturating_sub(1) as usize);
        let scroll_x = cursor_col.saturating_sub(inside.width.saturating_sub(1) as usize);
        hits[i] = (inside, scroll_y, scroll_x);
        frame.render_widget(
            Paragraph::new(input.value.as_str()).scroll((
                scroll_y.min(u16::MAX as usize) as u16,
                scroll_x.min(u16::MAX as usize) as u16,
            )),
            inside,
        );
        if i == editor.focus && inside.width > 0 && inside.height > 0 {
            frame.set_cursor_position((
                inside.x + (cursor_col - scroll_x).min(inside.width as usize - 1) as u16,
                inside.y + (cursor_row - scroll_y).min(inside.height as usize - 1) as u16,
            ));
        }
    }
    let hints = if compose {
        if running {
            "Request running. Esc stops waiting (cannot retract network delivery)."
        } else {
            "Tab / Shift+Tab fields | Ctrl+Enter or F5 send | Esc close"
        }
    } else if multiline {
        "Ctrl+Enter saves | Enter newline | Esc cancels"
    } else {
        "Enter applies | Tab next field | Esc cancels"
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(hints, Style::default().fg(p.accent))),
            Line::from("Left/Right, Home/End edit cursor; Ctrl+U clears field; paste supported."),
        ]),
        chunks[1],
    );
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn visible(app: &mut App, width: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, 12)).unwrap();
        terminal
            .draw(|frame| render_inspector(frame, app, frame.area()))
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn wrapped_unicode_body_can_reach_end_after_resize_and_pan_when_unwrapped() {
        let flow = json!({"id":"long", "resBody":format!("{} END-OF-BODY", "界".repeat(600)), "resBodyEncoding":"utf8"});
        let mut app = App::new("dark", true, Some(false));
        app.flows = vec![flow.clone()];
        app.detail = Some(flow);
        app.tab = 2;
        app.pretty = false;
        app.scroll = u16::MAX;
        assert!(visible(&mut app, 42).contains("END-OF-BODY"));
        app.scroll = u16::MAX;
        assert!(visible(&mut app, 78).contains("END-OF-BODY"));
        app.wrap = false;
        app.scroll = 0;
        assert!(!visible(&mut app, 42).contains("END-OF-BODY"));
        app.horizontal = 1200;
        assert!(visible(&mut app, 42).contains("END-OF-BODY"));
        app.wrap = true;
        app.scroll = u16::MAX;
        assert!(visible(&mut app, 42).contains("END-OF-BODY"));
    }
}
