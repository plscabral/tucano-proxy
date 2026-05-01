import type { Flow } from "./types";

function fullUrl(f: Flow): string {
  const defaultPort = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  const host = defaultPort ? f.host : `${f.host}:${f.port}`;
  return `${f.scheme}://${host}${f.path}`;
}

function decodeBody(body: string | null, encoding: "utf8" | "base64"): string | null {
  if (!body) return null;
  if (encoding === "base64") {
    try { return atob(body); } catch { return body; }
  }
  return body;
}

function shellSingleQuote(s: string): string {
  // Wrap in single quotes; embedded ' becomes '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pwshSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

const SKIP_HEADERS = new Set(["content-length", "host"]);

function relevantHeaders(headers: [string, string][]): [string, string][] {
  return headers.filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()));
}

/** cURL command (POSIX shell — bash/zsh/sh/macOS Terminal). */
export function toCurlBash(f: Flow): string {
  const parts: string[] = ["curl"];
  if (f.method !== "GET") parts.push("-X", f.method);
  parts.push(shellSingleQuote(fullUrl(f)));
  for (const [k, v] of relevantHeaders(f.reqHeaders)) {
    parts.push("-H", shellSingleQuote(`${k}: ${v}`));
  }
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  if (body) {
    parts.push("--data-raw", shellSingleQuote(body));
  }
  return parts.join(" \\\n  ");
}

/** cURL command for Windows cmd.exe (escapes via "" pairs). */
export function toCurlCmd(f: Flow): string {
  const q = (s: string) => `"${s.replace(/"/g, `""`)}"`;
  const parts: string[] = ["curl"];
  if (f.method !== "GET") parts.push("-X", f.method);
  parts.push(q(fullUrl(f)));
  for (const [k, v] of relevantHeaders(f.reqHeaders)) {
    parts.push("-H", q(`${k}: ${v}`));
  }
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  if (body) parts.push("--data-raw", q(body));
  return parts.join(" ^\n  ");
}

/** PowerShell `Invoke-WebRequest` equivalent. */
export function toPowershell(f: Flow): string {
  const headers: string[] = [];
  for (const [k, v] of relevantHeaders(f.reqHeaders)) {
    headers.push(`  ${pwshSingleQuote(k)} = ${pwshSingleQuote(v)}`);
  }
  const headerBlock = headers.length
    ? `$headers = @{\n${headers.join("\n")}\n}\n`
    : "";
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  const bodyArg = body ? ` -Body ${pwshSingleQuote(body)}` : "";
  const headerArg = headers.length ? " -Headers $headers" : "";
  return `${headerBlock}Invoke-WebRequest -Uri ${pwshSingleQuote(fullUrl(f))} -Method ${f.method}${headerArg}${bodyArg}`;
}

/** JavaScript `fetch()` snippet. */
export function toFetch(f: Flow): string {
  const headerEntries = relevantHeaders(f.reqHeaders).map(
    ([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  const init: string[] = [`  method: ${JSON.stringify(f.method)}`];
  if (headerEntries.length) {
    init.push(`  headers: {\n${headerEntries.join(",\n")}\n  }`);
  }
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  if (body) init.push(`  body: ${JSON.stringify(body)}`);
  return `fetch(${JSON.stringify(fullUrl(f))}, {\n${init.join(",\n")}\n});`;
}

/** Python `requests` snippet. */
export function toPython(f: Flow): string {
  const headerLines = relevantHeaders(f.reqHeaders).map(
    ([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
  );
  const headers = headerLines.length
    ? `headers = {\n${headerLines.join("\n")}\n}\n`
    : "";
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  const dataArg = body ? `, data=${JSON.stringify(body)}` : "";
  const headerArg = headerLines.length ? ", headers=headers" : "";
  return `import requests\n\n${headers}response = requests.${f.method.toLowerCase()}(\n    ${JSON.stringify(fullUrl(f))}${headerArg}${dataArg},\n)\nprint(response.status_code)\nprint(response.text)`;
}

/** HTTPie command. */
export function toHttpie(f: Flow): string {
  const parts: string[] = ["http"];
  parts.push(f.method);
  parts.push(shellSingleQuote(fullUrl(f)));
  for (const [k, v] of relevantHeaders(f.reqHeaders)) {
    parts.push(`${k}:${shellSingleQuote(v)}`);
  }
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  if (body) {
    // HTTPie auto-detects JSON; for raw body use --raw
    parts.push("--raw", shellSingleQuote(body));
  }
  return parts.join(" \\\n  ");
}

/** Raw HTTP/1.1 wire format (compatible with REST clients, paw, .http files). */
export function toHttpRaw(f: Flow): string {
  const lines: string[] = [];
  const reqLine = `${f.method} ${f.path} HTTP/${(f.httpVersion || "HTTP/1.1").replace(/^HTTP\//, "") || "1.1"}`;
  lines.push(reqLine);
  if (!f.reqHeaders.find(([k]) => k.toLowerCase() === "host")) {
    lines.push(`Host: ${f.host}`);
  }
  for (const [k, v] of f.reqHeaders) lines.push(`${k}: ${v}`);
  lines.push("");
  const body = decodeBody(f.reqBody, f.reqBodyEncoding);
  if (body) lines.push(body);
  return lines.join("\n");
}

export type ExportFormat = {
  id: string;
  label: string;
  build: (f: Flow) => string;
};

// ---------------------------------------------------------------------------
// Bulk / collection export
// ---------------------------------------------------------------------------

function buildPostmanUrl(f: Flow) {
  // Postman v2.1 wants the URL as a structured object. Providing only
  // `raw` makes Postman fail to import or parse — host/path/query/protocol
  // need to be split out explicitly.
  const raw = fullUrl(f);
  const [pathOnly, queryRaw = ""] = f.path.split("?", 2);
  const pathParts = pathOnly.split("/").filter(Boolean);
  const query = queryRaw
    ? queryRaw.split("&").map((kv) => {
        const eq = kv.indexOf("=");
        return eq >= 0
          ? { key: decodeURIComponent(kv.slice(0, eq)), value: decodeURIComponent(kv.slice(eq + 1)) }
          : { key: decodeURIComponent(kv), value: "" };
      })
    : [];
  const url: any = {
    raw,
    protocol: f.scheme,
    host: f.host.split("."),
    path: pathParts,
  };
  if (query.length) url.query = query;
  const isDefaultPort = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  if (!isDefaultPort) url.port = String(f.port);
  return url;
}

function safeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC4122-ish v4 from Math.random.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Postman Collection v2.1 — importable in Postman, Insomnia, Bruno, Hoppscotch. */
export function toPostmanCollection(flows: Flow[], name = "Tucano Capture"): string {
  const items = flows.map((f) => {
    const headers = relevantHeaders(f.reqHeaders).map(([key, value]) => ({ key, value, type: "text" }));
    const body = decodeBody(f.reqBody, f.reqBodyEncoding);
    const item: any = {
      name: f.note ? `${f.method} ${f.path} — ${f.note}` : `${f.method} ${f.path}`,
      request: {
        method: f.method,
        header: headers,
        url: buildPostmanUrl(f),
      },
      response: [],
    };
    if (body) {
      item.request.body = { mode: "raw", raw: body };
      const ct = f.reqContentType ?? "";
      if (ct.includes("json")) item.request.body.options = { raw: { language: "json" } };
    }
    if (f.note) item.request.description = f.note;
    return item;
  });
  return JSON.stringify({
    info: {
      _postman_id: safeUuid(),
      name,
      description: `Exported by Tucano Proxy on ${new Date().toISOString()} — ${flows.length} request(s)`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      _exporter_id: "tucano-proxy",
    },
    item: items,
  }, null, 2);
}

/** HAR 1.2 — drag into Chrome DevTools Network tab, Charles, Fiddler, etc. */
export function toHar(flows: Flow[]): string {
  const entries = flows.map((f) => {
    const reqHeaders = f.reqHeaders.map(([name, value]) => ({ name, value }));
    const resHeaders = f.resHeaders.map(([name, value]) => ({ name, value }));
    const reqBody = decodeBody(f.reqBody, f.reqBodyEncoding);
    const resBody = decodeBody(f.resBody, f.resBodyEncoding);
    const startedISO = new Date(f.startedAt).toISOString();
    const time = f.durationMs ?? 0;
    return {
      startedDateTime: startedISO,
      time,
      _note: f.note ?? undefined,
      request: {
        method: f.method,
        url: fullUrl(f),
        httpVersion: f.httpVersion || "HTTP/1.1",
        cookies: [],
        headers: reqHeaders,
        queryString: [],
        headersSize: -1,
        bodySize: f.reqSize,
        ...(reqBody ? { postData: { mimeType: f.reqContentType ?? "", text: reqBody } } : {}),
      },
      response: {
        status: f.status ?? 0,
        statusText: f.statusText ?? "",
        httpVersion: f.httpVersion || "HTTP/1.1",
        cookies: [],
        headers: resHeaders,
        content: {
          size: f.resSize,
          mimeType: f.resContentType ?? "",
          text: resBody ?? "",
          ...(f.resBodyEncoding === "base64" ? { encoding: "base64" } : {}),
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: f.resSize,
      },
      cache: {},
      timings: { send: 0, wait: time, receive: 0 },
    };
  });
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Tucano Proxy", version: "0.1" },
      entries,
    },
  }, null, 2);
}

export type CollectionFormat = {
  id: string;
  label: string;
  extension: string;
  build: (flows: Flow[]) => string;
};

export const COLLECTION_FORMATS: CollectionFormat[] = [
  { id: "postman", label: "Postman Collection (v2.1)", extension: "postman_collection.json", build: (fs) => toPostmanCollection(fs) },
  { id: "har",     label: "HAR (HTTP Archive)",        extension: "har",                      build: toHar },
];

// ---------------------------------------------------------------------------
// LLM-friendly markdown export
// ---------------------------------------------------------------------------

export type LlmExportOptions = {
  prompt: string;
  targetLanguage: string;
  redactSecrets: boolean;
  /** Replace bodies of non-API content types (html/css/js/images/etc) with a placeholder. */
  skipNonApiBodies: boolean;
  /** Max chars kept per body before truncation. <=0 disables truncation. */
  maxBodyChars: number;
};

const NON_API_CT = [
  /^text\/html\b/i,
  /^text\/css\b/i,
  /^application\/javascript\b/i,
  /^application\/x-javascript\b/i,
  /^text\/javascript\b/i,
  /^application\/wasm\b/i,
  /^image\//i,
  /^video\//i,
  /^audio\//i,
  /^font\//i,
  /^application\/font/i,
];

function isNonApiContentType(ct: string | null): boolean {
  if (!ct) return false;
  return NON_API_CT.some((re) => re.test(ct));
}

export const LLM_TARGET_LANGUAGES: { id: string; label: string }[] = [
  { id: "csharp",     label: "C# / .NET (HttpClient)" },
  { id: "typescript", label: "TypeScript (fetch)" },
  { id: "python",     label: "Python (requests)" },
  { id: "go",         label: "Go (net/http)" },
  { id: "java",       label: "Java (HttpClient)" },
  { id: "other",      label: "Outro / livre" },
];

export const DEFAULT_LLM_PROMPT = (lang: string) =>
  `Você é um engenheiro de software experiente em ${lang}. Reconstrua o fluxo HTTP abaixo como um programa idiomático que executa as chamadas na ordem dada, preservando headers relevantes, corpos de requisição e tratando dependências entre chamadas (por exemplo, um token retornado por uma chamada anterior usado em uma posterior). Comente o código em pontos não óbvios e, ao final, explique brevemente o fluxo.`;

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

function maskHeaders(headers: [string, string][], redact: boolean): [string, string][] {
  const filtered = relevantHeaders(headers);
  if (!redact) return filtered;
  return filtered.map(([k, v]) =>
    SENSITIVE_HEADERS.has(k.toLowerCase()) ? [k, "***REDACTED***"] : [k, v],
  );
}

function isJsonContentType(ct: string | null): boolean {
  return !!ct && /\bjson\b/i.test(ct);
}

function escapeFenceContent(s: string): string {
  // Avoid breaking fences if body itself contains ``` — neutralize.
  return s.replace(/```/g, "`​``");
}

function formatBodyBlock(
  body: string | null,
  encoding: "utf8" | "base64",
  contentType: string | null,
  size: number,
  opts: { skipNonApi: boolean; maxChars: number },
): string {
  if (!body) return "_(empty)_\n";
  if (encoding === "base64") {
    return `_[binary, ${size} bytes${contentType ? `, ${contentType}` : ""}]_\n`;
  }
  if (opts.skipNonApi && isNonApiContentType(contentType)) {
    return `_[skipped ${contentType}, ${size} bytes — not relevant for API flow]_\n`;
  }
  let content = body;
  let lang = "";
  if (isJsonContentType(contentType)) {
    lang = "json";
    try { content = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep raw */ }
  } else if (contentType) {
    if (/xml/i.test(contentType)) lang = "xml";
    else if (/html/i.test(contentType)) lang = "html";
  }
  let truncatedNote = "";
  if (opts.maxChars > 0 && content.length > opts.maxChars) {
    truncatedNote = `\n…[truncated, showing ${opts.maxChars} of ${content.length} chars]`;
    content = content.slice(0, opts.maxChars);
  }
  return "```" + lang + "\n" + escapeFenceContent(content) + truncatedNote + "\n```\n";
}

function headersTable(headers: [string, string][]): string {
  if (headers.length === 0) return "_(none)_\n";
  const lines = ["| name | value |", "| ---- | ----- |"];
  for (const [k, v] of headers) {
    const safeV = String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${k} | ${safeV} |`);
  }
  return lines.join("\n") + "\n";
}

function uniqueHosts(flows: Flow[]): string[] {
  const set = new Set<string>();
  for (const f of flows) set.add(f.host);
  return [...set];
}

/** LLM-friendly Markdown — designed to be pasted into an LLM so it reconstructs the flow as code. */
export function toLlmMarkdown(flows: Flow[], opts: LlmExportOptions): string {
  const langLabel =
    LLM_TARGET_LANGUAGES.find((l) => l.id === opts.targetLanguage)?.label ?? opts.targetLanguage;
  const out: string[] = [];

  out.push(
    "<!--",
    "COMO USAR ESTE ARQUIVO:",
    "1. Abra um chat de LLM (Claude, ChatGPT, etc).",
    "2. Cole TODO o conteúdo deste arquivo na conversa.",
    "3. A LLM vai reconstruir o fluxo HTTP no idioma indicado abaixo.",
    "Dica: se a resposta vier truncada, peça \"continue\" ou divida o fluxo em partes.",
    "-->",
    "",
    "# Tucano — Fluxo HTTP capturado",
    "",
    "> " + opts.prompt.replace(/\n/g, "\n> "),
    "",
    "## Contexto",
    `- Exportado em: ${new Date().toISOString()}`,
    `- Total de chamadas: ${flows.length}`,
    `- Hosts: ${uniqueHosts(flows).join(", ") || "—"}`,
    `- Linguagem-alvo: ${langLabel}`,
    `- Headers sensíveis mascarados: ${opts.redactSecrets ? "sim" : "não"}`,
    `- Bodies não-API ignorados: ${opts.skipNonApiBodies ? "sim" : "não"}`,
    `- Limite por body: ${opts.maxBodyChars > 0 ? `${opts.maxBodyChars} chars` : "sem limite"}`,
    "",
    "## Fluxo",
    "",
  );

  const bodyOpts = { skipNonApi: opts.skipNonApiBodies, maxChars: opts.maxBodyChars };

  flows.forEach((f, i) => {
    const url = fullUrl(f);
    const status = f.status != null ? `${f.status}${f.statusText ? " " + f.statusText : ""}` : "(no response)";
    const dur = f.durationMs != null ? `${f.durationMs} ms` : "—";
    out.push(`### ${i + 1}. ${f.method} ${url}  →  ${status}  (${dur})`);
    if (f.note) out.push("", `**Note:** ${f.note}`);
    out.push("", "**Request headers**", headersTable(maskHeaders(f.reqHeaders, opts.redactSecrets)));
    out.push(
      `**Request body** (${f.reqContentType ?? "no content-type"}, ${f.reqSize} bytes)`,
      "",
      formatBodyBlock(f.reqBody, f.reqBodyEncoding, f.reqContentType, f.reqSize, bodyOpts),
    );
    out.push("**Response headers**", headersTable(maskHeaders(f.resHeaders, opts.redactSecrets)));
    out.push(
      `**Response body** (${f.resContentType ?? "no content-type"}, ${f.resSize} bytes)`,
      "",
      formatBodyBlock(f.resBody, f.resBodyEncoding, f.resContentType, f.resSize, bodyOpts),
    );
    if (f.error) out.push(`**Error:** ${f.error}`, "");
    if (i < flows.length - 1) out.push("---", "");
  });

  return out.join("\n");
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "curl-bash",  label: "cURL (bash / zsh)",      build: toCurlBash },
  { id: "curl-cmd",   label: "cURL (Windows cmd)",     build: toCurlCmd },
  { id: "powershell", label: "PowerShell",             build: toPowershell },
  { id: "fetch",      label: "JavaScript (fetch)",     build: toFetch },
  { id: "python",     label: "Python (requests)",      build: toPython },
  { id: "httpie",     label: "HTTPie",                 build: toHttpie },
  { id: "http",       label: "Raw HTTP/1.1",           build: toHttpRaw },
];
