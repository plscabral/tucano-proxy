// Lightweight pretty-printers for response bodies. Kept dependency-free —
// debugging proxies don't need a full Prettier install.

export function beautifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Pretty-print an HTML or XML string. Splits at tag boundaries and indents
 * by nesting depth. Best-effort: keeps inline text content on the same line
 * as its enclosing tag when there are no nested elements between them, so
 * <p>hello world</p> stays compact instead of being shredded.
 */
export function beautifyMarkup(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  // Insert newline between adjacent tags so we can iterate line by line.
  const exploded = trimmed
    .replace(/></g, ">\n<")
    .replace(/(<\/[a-zA-Z][^>]*>)([^<\s])/g, "$1\n$2"); // text right after closing tag

  const lines = exploded.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  let depth = 0;
  const indent = (n: number) => "  ".repeat(Math.max(0, n));

  for (const line of lines) {
    if (line.startsWith("<!--") || line.startsWith("<![") || line.startsWith("<!DOCTYPE") || line.startsWith("<?")) {
      out.push(indent(depth) + line);
      continue;
    }

    const isClosing = /^<\/[^>]+>/.test(line);
    const isSelfClosing = /\/\s*>$/.test(line) || /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(line);
    // Lines containing both an open and close tag (e.g. "<p>text</p>")
    const hasInlineClose = /^<[^/!?][^>]*>[^<]*<\/[^>]+>$/.test(line);

    if (isClosing) {
      depth = Math.max(0, depth - 1);
      out.push(indent(depth) + line);
    } else if (isSelfClosing || hasInlineClose) {
      out.push(indent(depth) + line);
    } else if (/^</.test(line)) {
      out.push(indent(depth) + line);
      depth++;
    } else {
      // bare text node
      out.push(indent(depth) + line);
    }
  }
  return out.join("\n");
}

export type BeautifyLang = "json" | "xml" | "html" | "raw";

export function beautify(text: string, lang: BeautifyLang): string {
  switch (lang) {
    case "json": return beautifyJson(text);
    case "xml":
    case "html": return beautifyMarkup(text);
    default: return text;
  }
}

export function isBeautifiable(lang: BeautifyLang): boolean {
  return lang === "json" || lang === "xml" || lang === "html";
}
