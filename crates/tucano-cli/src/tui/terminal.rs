use base64::{engine::general_purpose::STANDARD, Engine};
use crossterm::{
    cursor,
    event::{DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::style::{Color, Style};
use std::{
    io::{self, IsTerminal, Write},
    time::{Duration, Instant},
};

/// Only renderer-owned escape sequences may reach the terminal. Keep line breaks
/// and tabs for documents, but strip OSC/DCS/CSI payloads as well as their introducers.
pub(crate) fn safe(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(262_144));
    let mut chars = input.chars().take(262_144).peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('^') | Some('_') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || c == '\u{9c}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\u{9b}' => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            '\u{9d}' | '\u{90}' | '\u{9e}' | '\u{9f}' => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' || c == '\u{9c}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            '\n' => output.push('\n'),
            '\t' => output.push_str("    "),
            c if c.is_control()
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}') =>
                {}
            c => output.push(c),
        }
    }
    output
}
pub(super) fn single(input: &str) -> String {
    safe(input).replace('\n', " ")
}

pub(super) fn colors_enabled(choice: Option<bool>) -> bool {
    choice.unwrap_or_else(|| {
        std::env::var_os("NO_COLOR").is_none() && std::env::var("TERM").as_deref() != Ok("dumb")
    })
}

#[derive(Clone, Copy)]
pub(crate) struct Palette {
    pub mono: bool,
    pub fg: Color,
    pub bg: Color,
    pub dim: Color,
    pub accent: Color,
    pub selection: Color,
    pub good: Color,
    pub bad: Color,
}
impl Palette {
    pub fn new(dark: bool, color: Option<bool>) -> Self {
        let mono = !colors_enabled(color);
        if mono {
            return Self {
                mono,
                fg: Color::Reset,
                bg: Color::Reset,
                dim: Color::Reset,
                accent: Color::Reset,
                selection: Color::Reset,
                good: Color::Reset,
                bad: Color::Reset,
            };
        }
        Self {
            mono,
            fg: if dark {
                Color::Rgb(237, 238, 243)
            } else {
                Color::Rgb(8, 13, 27)
            },
            bg: if dark {
                Color::Rgb(15, 16, 20)
            } else {
                Color::Rgb(251, 251, 248)
            },
            dim: if dark {
                Color::Rgb(155, 149, 174)
            } else {
                Color::Rgb(103, 96, 120)
            },
            accent: if dark {
                Color::Rgb(149, 131, 231)
            } else {
                Color::Rgb(106, 87, 224)
            },
            selection: if dark {
                Color::Rgb(43, 32, 115)
            } else {
                Color::Rgb(238, 235, 251)
            },
            good: if dark {
                Color::Rgb(138, 210, 171)
            } else {
                Color::Rgb(34, 113, 78)
            },
            bad: if dark {
                Color::Rgb(244, 151, 149)
            } else {
                Color::Rgb(169, 47, 53)
            },
        }
    }
    pub fn base(self) -> Style {
        Style::default().fg(self.fg).bg(self.bg)
    }
}

type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Send + Sync + 'static>;

pub(crate) struct Guard {
    old_hook: Option<PanicHook>,
    alternate: bool,
}
fn restore(alternate: bool) {
    let _ = execute!(
        io::stdout(),
        DisableMouseCapture,
        DisableBracketedPaste,
        cursor::Show
    );
    if alternate {
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
    let _ = disable_raw_mode();
}
impl Guard {
    pub fn enter() -> anyhow::Result<Self> {
        Self::enter_mode(true)
    }
    pub fn enter_inline() -> anyhow::Result<Self> {
        Self::enter_mode(false)
    }
    fn enter_mode(alternate: bool) -> anyhow::Result<Self> {
        anyhow::ensure!(io::stdin().is_terminal() && io::stdout().is_terminal(), "The terminal interface requires an interactive terminal. Use flows list --json for scripts.");
        enable_raw_mode()?;
        let old_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore(alternate);
            eprintln!("Tucano terminal error: {}", safe(&info.to_string()));
        }));
        let guard = Self {
            old_hook: Some(old_hook),
            alternate,
        };
        if alternate {
            execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture)?;
        }
        execute!(io::stdout(), EnableBracketedPaste, cursor::Hide)?;
        Ok(guard)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        restore(self.alternate);
        if !std::thread::panicking() {
            if let Some(hook) = self.old_hook.take() {
                std::panic::set_hook(hook);
            }
        }
    }
}

pub(crate) fn auto_dark() -> bool {
    if let Some(dark) = query_background() {
        return dark;
    }
    std::env::var("COLORFGBG")
        .ok()
        .and_then(|s| s.rsplit(';').next()?.parse::<u8>().ok())
        .map(|n| n < 7 || n == 8)
        .unwrap_or(true)
}
#[cfg(unix)]
fn query_background() -> Option<bool> {
    // Never probe multiplexers, dumb terminals, or redirected streams. Query
    // before crossterm's input reader exists, so two readers never race stdin.
    let term = std::env::var("TERM").unwrap_or_default();
    if term == "dumb" || std::env::var_os("TMUX").is_some() || std::env::var_os("STY").is_some() {
        return None;
    }
    let mut stdout = io::stdout();
    stdout.write_all(b"\x1b]11;?\x07").ok()?;
    stdout.flush().ok()?;
    let deadline = Instant::now() + Duration::from_millis(120);
    let mut reply = Vec::with_capacity(128);
    while Instant::now() < deadline && reply.len() < 128 {
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let left = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(120) as i32;
        // The descriptor is borrowed, never closed; reads are one byte after poll.
        if unsafe { libc::poll(&mut fd, 1, left) } <= 0 {
            break;
        }
        let mut byte = 0u8;
        if unsafe { libc::read(libc::STDIN_FILENO, (&mut byte as *mut u8).cast(), 1) } != 1 {
            break;
        }
        reply.push(byte);
        if byte == 7 || reply.ends_with(b"\x1b\\") {
            break;
        }
    }
    parse_background(&String::from_utf8_lossy(&reply))
}
#[cfg(not(unix))]
fn query_background() -> Option<bool> {
    None
}
fn parse_background(reply: &str) -> Option<bool> {
    let value = reply
        .split("11;rgb:")
        .nth(1)?
        .trim_end_matches(['\u{7}', '\u{1b}', '\\']);
    let mut channels = value.split('/');
    let mut rgb = [0.0f64; 3];
    for channel in &mut rgb {
        let text = channels.next()?;
        if text.is_empty() || text.len() > 4 {
            return None;
        }
        *channel =
            u16::from_str_radix(text, 16).ok()? as f64 / ((1u32 << (4 * text.len())) - 1) as f64;
    }
    if channels.next().is_some() {
        return None;
    }
    Some(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 0.5)
}

pub(super) struct Logo {
    protocol: Option<&'static str>,
    encoded: String,
    drawn: bool,
}
impl Logo {
    pub fn new(color: Option<bool>) -> Self {
        let term = std::env::var("TERM").unwrap_or_default();
        let program = std::env::var("TERM_PROGRAM").unwrap_or_default();
        let protocol = if !colors_enabled(color)
            || std::env::var_os("TMUX").is_some()
            || std::env::var_os("STY").is_some()
        {
            None
        } else if term.contains("kitty") || program == "WezTerm" || program == "ghostty" {
            Some("kitty")
        } else if program == "iTerm.app" {
            Some("iterm")
        } else {
            None
        };
        if protocol.is_none() {
            return Self {
                protocol,
                encoded: String::new(),
                drawn: false,
            };
        }
        let bytes = include_bytes!("../../../../public/tucano-proxy.png");
        // A small PNG avoids repeatedly transmitting the full application icon.
        let encoded = image::load_from_memory(bytes)
            .ok()
            .and_then(|image| {
                let image = image.thumbnail(64, 64);
                let mut out = std::io::Cursor::new(Vec::new());
                image.write_to(&mut out, image::ImageFormat::Png).ok()?;
                Some(STANDARD.encode(out.into_inner()))
            })
            .unwrap_or_default();
        Self {
            protocol,
            encoded,
            drawn: false,
        }
    }
    pub fn enabled(&self) -> bool {
        self.protocol.is_some() && !self.encoded.is_empty()
    }
    pub fn invalidate(&mut self) {
        self.drawn = false;
    }
    pub fn draw(&mut self) -> io::Result<()> {
        if self.drawn || !self.enabled() {
            return Ok(());
        }
        let mut out = io::stdout();
        write!(out, "\x1b7\x1b[1;2H")?;
        if self.protocol == Some("kitty") {
            write!(out, "\x1b_Ga=d,d=i,i=7341,q=2\x1b\\")?;
            let chunks = self.encoded.len().div_ceil(4096);
            for (index, chunk) in self.encoded.as_bytes().chunks(4096).enumerate() {
                if index == 0 {
                    write!(
                        out,
                        "\x1b_Ga=T,f=100,i=7341,c=4,r=2,q=2,m={};",
                        u8::from(index + 1 < chunks)
                    )?;
                } else {
                    write!(out, "\x1b_Gm={};", u8::from(index + 1 < chunks))?;
                }
                out.write_all(chunk)?;
                out.write_all(b"\x1b\\")?;
            }
        } else {
            write!(
                out,
                "\x1b]1337;File=inline=1;width=4;height=2;preserveAspectRatio=1:{}\x07",
                self.encoded
            )?;
        }
        write!(out, "\x1b8")?;
        out.flush()?;
        self.drawn = true;
        Ok(())
    }
}
impl Drop for Logo {
    fn drop(&mut self) {
        if self.protocol == Some("kitty") {
            let _ = write!(io::stdout(), "\x1b_Ga=d,d=i,i=7341,q=2\x1b\\");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_controls_cannot_change_terminal_state() {
        assert_eq!(
            safe("ok\x1b]52;c;c2VjcmV0\x07safe\x1b[31m!\x1bPpayload\x1b\\\u{202e}end"),
            "oksafe!end"
        );
        assert_eq!(
            safe("\u{9d}52;clipboard\u{9c}hello\nworld\t!"),
            "hello\nworld    !"
        );
    }
    #[test]
    fn parses_terminal_background_precision_and_rejects_malformed_replies() {
        assert_eq!(
            parse_background("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"),
            Some(false)
        );
        assert_eq!(parse_background("\x1b]11;rgb:12/14/18\x07"), Some(true));
        assert_eq!(parse_background("\x1b]11;rgb:fffff/0/0\x07"), None);
    }
}
