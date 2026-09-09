use super::{body_bytes, inspected_text, text, BODY_LIMIT};
use quick_xml::{events::Event, Reader, Writer};
use serde::{de::IgnoredAny, Deserialize};
use serde_json::Value;

const FORMATTED_LIMIT: usize = BODY_LIMIT * 2 - 1024;

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Html,
    Json,
    Xml,
    Text,
}

impl Kind {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Html => "HTML",
            Self::Json => "JSON",
            Self::Xml => "XML",
            Self::Text => "Text",
        }
    }
}

pub(super) fn kind(flow: &Value, response: bool) -> Kind {
    let mut mime = text(
        flow,
        if response {
            "resContentType"
        } else {
            "reqContentType"
        },
    );
    if mime.is_empty() {
        if let Some(headers) = flow[if response { "resHeaders" } else { "reqHeaders" }].as_array() {
            mime = headers
                .iter()
                .find_map(|header| {
                    (header[0].as_str()?.eq_ignore_ascii_case("content-type"))
                        .then(|| header[1].as_str())
                        .flatten()
                })
                .unwrap_or("");
        }
    }
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime == "text/html" || mime == "application/xhtml+xml" {
        return Kind::Html;
    }
    if mime.ends_with("/json") || mime.ends_with("+json") {
        return Kind::Json;
    }
    if mime.ends_with("/xml") || mime.ends_with("+xml") {
        return Kind::Xml;
    }
    let body = text(flow, if response { "resBody" } else { "reqBody" }).trim_start();
    if body.starts_with(['{', '[']) {
        Kind::Json
    } else if body
        .get(..15)
        .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype html>"))
        || body
            .get(..5)
            .is_some_and(|s| s.eq_ignore_ascii_case("<html"))
    {
        Kind::Html
    } else if body.starts_with("<?xml") {
        Kind::Xml
    } else {
        Kind::Text
    }
}

pub(super) fn render(flow: &Value, response: bool, width: usize) -> String {
    let bytes = body_bytes(flow, response);
    let raw = String::from_utf8_lossy(&bytes);
    if raw.is_empty() {
        return inspected_text(flow, response, "");
    }
    let format = kind(flow, response);
    let result = match format {
        Kind::Html => html(&raw, width),
        Kind::Json => json(&raw),
        Kind::Xml => xml(&raw),
        Kind::Text => return inspected_text(flow, response, &raw),
    };
    match result {
        Ok(mut formatted) => {
            if formatted.len() > FORMATTED_LIMIT {
                let mut end = FORMATTED_LIMIT;
                while !formatted.is_char_boundary(end) {
                    end -= 1;
                }
                formatted.truncate(end);
                formatted.push_str(
                    "\n[Formatted preview limited. Switch to Source or export the capture.]",
                );
            }
            if formatted.trim().is_empty() {
                formatted =
                    "[No visible text in this document. Switch to Source to inspect markup.]"
                        .into();
            }
            inspected_text(flow, response, &formatted)
        }
        Err(error) => inspected_text(
            flow,
            response,
            &format!(
                "[Cannot preview {}: {error}. Showing source.]\n\n{raw}",
                format.label()
            ),
        ),
    }
}

fn html(raw: &str, width: usize) -> Result<String, String> {
    // No CSS engine, script execution, image loading or link fetching.
    let config = html2text::config::plain()
        .unicode_strikeout(false)
        .min_wrap_width(1)
        .allow_width_overflow();
    let dom = config
        .parse_html(raw.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut pending = vec![(dom.document.clone(), 0)];
    while let Some((node, depth)) = pending.pop() {
        if depth > 128 {
            return Err("document nesting exceeds the preview limit".into());
        }
        pending.extend(
            node.children
                .borrow()
                .iter()
                .map(|child| (child.clone(), depth + 1)),
        );
    }
    let tree = config.dom_to_render_tree(&dom).map_err(|e| e.to_string())?;
    config
        .render_to_string(tree, width.max(1))
        .map_err(|e| e.to_string())
}

fn json(raw: &str) -> Result<String, String> {
    // Validate without materializing Value: preserve number lexemes, duplicate
    // keys and input key order rather than rewriting the captured evidence.
    let mut parser = serde_json::Deserializer::from_str(raw);
    IgnoredAny::deserialize(&mut parser).map_err(|e| e.to_string())?;
    parser.end().map_err(|e| e.to_string())?;
    let mut out = String::with_capacity(raw.len());
    let mut depth: usize = 0;
    let mut quoted = false;
    let mut escaped = false;
    let mut previous = '\0';
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            previous = c;
            continue;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                out.push(c);
            }
            '{' | '[' => {
                out.push(c);
                depth += 1;
                while chars.peek().is_some_and(char::is_ascii_whitespace) {
                    chars.next();
                }
                let closing = if c == '{' { '}' } else { ']' };
                if chars.peek() != Some(&closing) {
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                if !matches!(previous, '{' | '[') {
                    newline(&mut out, depth);
                }
                out.push(c);
            }
            ',' => {
                out.push(c);
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            _ => out.push(c),
        }
        previous = c;
        if out.len() > FORMATTED_LIMIT {
            return Err("formatted document exceeds the preview limit".into());
        }
    }
    Ok(out)
}

fn newline(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn xml(raw: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(raw);
    let mut writer = Writer::new_with_indent(Vec::with_capacity(raw.len()), b' ', 2);
    let mut depth: usize = 0;
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match &event {
            Event::Start(_) => {
                depth += 1;
                if depth > 128 {
                    return Err("document nesting exceeds the preview limit".into());
                }
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Eof => {
                if depth != 0 {
                    return Err("incomplete XML document".into());
                }
                break;
            }
            _ => {}
        }
        // Preserve text, CDATA, comments, attributes and entity references.
        // The event reader never resolves DTDs or external entities.
        writer.write_event(event).map_err(|e| e.to_string())?;
        if writer.get_ref().len() > FORMATTED_LIMIT {
            return Err("formatted document exceeds the preview limit".into());
        }
    }
    String::from_utf8(writer.into_inner()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn html_exposes_readable_content_but_not_active_content_or_terminal_controls() {
        let flow = json!({"resContentType":"text/html", "resBody":"<html><head><style>STYLE_SECRET</style><script>SCRIPT_SECRET</script></head><body><h1>Example Domain</h1><p>A &amp; B</p><ul><li>First</li><li>Second</li></ul><a href='https://example.test/docs'>Docs</a><p>&#27;]52;c;SECRETDATA&#7;safe</p></body></html>"});
        let output = render(&flow, true, 60);
        assert!(output.contains("Example Domain") && output.contains("A & B"));
        assert!(output.contains("First") && output.contains("Second"));
        assert!(output.contains("https://example.test/docs"));
        assert!(!output.contains("SCRIPT_SECRET") && !output.contains("STYLE_SECRET"));
        assert!(!output.contains('\u{1b}'));
        assert!(super::super::body_text(&flow, true, false).contains("<h1>"));
    }

    #[test]
    fn json_preview_preserves_numbers_duplicate_keys_and_escaped_strings() {
        let raw = r#"{"z":90071992547409931234567890,"z":1.2300e+42,"text":"a\\b\"c","a":[]}"#;
        let formatted = super::json(raw).unwrap();
        let mut de = serde_json::Deserializer::from_str(&formatted);
        IgnoredAny::deserialize(&mut de).unwrap();
        assert!(formatted.contains("90071992547409931234567890"));
        assert!(formatted.contains("1.2300e+42"));
        assert_eq!(formatted.matches("\"z\"").count(), 2);
        assert!(formatted.find("\"z\"") < formatted.find("\"a\""));
        assert!(formatted.contains(r#""text": "a\\b\"c""#));
    }

    #[test]
    fn xml_preview_preserves_mixed_content_cdata_and_external_entity_references() {
        let raw = "<!DOCTYPE root [<!ENTITY local SYSTEM 'file:///not-read'>]><root attr='a &amp; b'><p>Hello <b>world</b>!</p><data><![CDATA[<raw>&bytes]]></data><value>&local;</value></root>";
        let formatted = xml(raw).unwrap();
        assert!(formatted.contains("\n  <p>"));
        assert!(formatted.contains("Hello <b>world</b>!"));
        assert!(formatted.contains("<![CDATA[<raw>&bytes]]>"));
        assert!(formatted.contains("&local;") && formatted.contains("attr='a &amp; b'"));
    }

    #[test]
    fn invalid_and_truncated_xml_keeps_source_available() {
        let flow = json!({"resContentType":"application/problem+xml; charset=utf-8", "resBody":"<root><broken></root>", "resTruncated":true});
        let output = render(&flow, true, 40);
        assert!(output.contains("Cannot preview XML"));
        assert!(output.contains("<root><broken></root>"));
        assert!(output.contains("captured body is truncated"));
    }
}
