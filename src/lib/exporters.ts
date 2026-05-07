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
  /** Emit a "Steps (estruturado)" section that pre-parses bodies and detects cross-step placeholders. */
  includeStructuredSteps: boolean;
  /** Include cleaned response bodies (HTML/JSON/XML) so the LLM can derive extraction selectors. */
  includeResponseBodies: boolean;
};

export const LLM_TARGET_LANGUAGES: { id: string; label: string }[] = [
  { id: "csharp",     label: "C# / .NET (HttpClient)" },
  { id: "typescript", label: "TypeScript (fetch)" },
  { id: "python",     label: "Python (requests)" },
  { id: "go",         label: "Go (net/http)" },
  { id: "java",       label: "Java (HttpClient)" },
  { id: "other",      label: "Outro / livre" },
];

export const DEFAULT_LLM_PROMPT = (lang: string) =>
  `Você é um engenheiro de software experiente em ${lang}.

Antes de gerar código:
1. Inspecione o repositório atual e identifique o padrão usado para representar chamadas HTTP (classes, helpers, naming, montagem de body/headers, parsing de resposta). Reproduza ESSE padrão — não invente uma estrutura nova.
2. Em seguida, traduza o fluxo abaixo respeitando o padrão do repositório: cada item da seção "Steps (estruturado)" vira uma unidade do framework existente, mantendo método, URL, headers, encoding/charset, content-type e os placeholders \`{varN}\` exatamente como marcados.
3. Quando um placeholder tiver \`from: stepN + locator\`, gere o código que extrai esse valor da resposta do step indicado usando os helpers de parsing já existentes no repositório (XPath/regex/JSON path conforme o estilo da casa).
4. Quando um step incluir \`response.body\`, use o conteúdo para derivar os seletores/localizadores corretos (XPath, CSS selector, JSON path, regex) para extrair dados em tela. Prefira seletores estáveis (id, name, atributos semânticos) a posicionais.

Preserve a ordem das chamadas, headers relevantes e bodies. Comente apenas pontos não óbvios e, ao final, descreva em uma frase o que o fluxo faz.`;

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

// ---- Structured steps -----------------------------------------------------

type Placeholder = {
  token: string;          // e.g. "{var1}"
  value: string;          // the literal it stands for (kept for the locator hint)
  fromStep: number;       // 1-based index of the prior step whose response carries this value
  locator: string;        // hint on how to extract from that step's response
};

type LlmStep = {
  index: number;
  name: string;
  method: string;
  url: string;
  charset: string | null;
  contentType: string | null;
  headers: [string, string][];
  bodyKind: "form" | "json" | "raw" | "empty" | "binary";
  bodyForm?: [string, string][];      // values may already contain {varN}
  bodyJson?: string;                  // pretty JSON string (with placeholders substituted)
  bodyRaw?: string;                   // raw body (with placeholders substituted)
  bodyNote?: string;                  // e.g. "binary, 1234 bytes"
  responseStatus: number | null;
  responseStatusText: string | null;
  responseContentType: string | null;
  responseHeaders: [string, string][];
  responseBody?: string;
  durationMs: number | null;
  note?: string | null;
  error?: string | null;
  placeholders: Placeholder[];
};

function parseCharset(ct: string | null): string | null {
  if (!ct) return null;
  const m = /charset\s*=\s*([^;\s]+)/i.exec(ct);
  return m ? m[1] : null;
}

function stepNameFromUrl(method: string, path: string, index: number): string {
  const [base, query = ""] = path.split("?", 2);
  const lastSeg = base.split("/").filter(Boolean).pop() ?? "";
  const qparams = new URLSearchParams(query);
  const hint = qparams.get("f") ?? qparams.get("a") ?? qparams.get("action") ?? lastSeg;
  const cleaned = (hint || `${method.toLowerCase()}_${index}`).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `step${index}`;
}

function parseFormBody(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : "";
    try {
      out.push([decodeURIComponent(k.replace(/\+/g, " ")), decodeURIComponent(v.replace(/\+/g, " "))]);
    } catch {
      out.push([k, v]);
    }
  }
  return out;
}

const PLACEHOLDER_STOPLIST = new Set([
  "application/json", "application/x-www-form-urlencoded", "text/html", "text/plain",
  "gzip, deflate, br", "keep-alive", "no-cache", "max-age=0",
]);

function isPlaceholderCandidate(v: string): boolean {
  if (!v) return false;
  if (v.length < 8) return false;
  if (PLACEHOLDER_STOPLIST.has(v.toLowerCase())) return false;
  // Skip pure numbers and common short ids — but accept long opaque tokens.
  if (/^\d+$/.test(v) && v.length < 10) return false;
  return true;
}

function locatorHint(value: string, prevResponse: string, prevContentType: string | null): string {
  // JSON path hint
  if (prevContentType && /json/i.test(prevContentType)) {
    try {
      const obj = JSON.parse(prevResponse);
      const path = findJsonPath(obj, value);
      if (path) return `json:${path}`;
    } catch { /* fall through */ }
  }
  // HTML attribute hint: look for name="..." value="<value>" or value="<value>" name="..."
  const attrMatch = new RegExp(`name=["']([^"']+)["'][^>]*value=["']${escapeRegex(value)}["']`).exec(prevResponse)
                 ?? new RegExp(`value=["']${escapeRegex(value)}["'][^>]*name=["']([^"']+)["']`).exec(prevResponse);
  if (attrMatch) return `html:input[name="${attrMatch[1]}"]@value`;
  // Generic regex fallback — capture by quoting whatever surrounds the value
  const idx = prevResponse.indexOf(value);
  if (idx >= 0) {
    const before = prevResponse.slice(Math.max(0, idx - 12), idx).replace(/\s+/g, " ");
    return `regex:${escapeRegex(before).slice(-10)}([^"'<>&\\s]+)`;
  }
  return "regex:(unknown)";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findJsonPath(obj: unknown, target: string, path = "$"): string | null {
  if (obj == null) return null;
  if (typeof obj === "string") return obj === target ? path : null;
  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj) === target ? path : null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = findJsonPath(obj[i], target, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const r = findJsonPath(v, target, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

function isTextualContentType(ct: string | null): boolean {
  if (!ct) return false;
  const t = ct.toLowerCase();
  return t.includes("html") || t.includes("json") || t.includes("xml") ||
    t.includes("text/") || t.includes("graphql");
}

function compactBody(body: string, ct: string | null): string {
  const t = (ct ?? "").toLowerCase();
  if (t.includes("html")) {
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+on\w+="[^"]*"/gi, "")
      .replace(/\s+on\w+='[^']*'/gi, "")
      .replace(/\s+style="[^"]*"/gi, "")
      .replace(/\s+style='[^']*'/gi, "")
      .replace(/<(div|span)[^>]*>\s*<\/\1>/gi, "")
      .replace(/<img[^>]+src=["']data:[^"']*["'][^>]*\/?>/gi, "")
      .replace(/\s+src=["']data:[^"']*["']/gi, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  }
  if (t.includes("json")) {
    try { return JSON.stringify(JSON.parse(body)); } catch { /* fall through */ }
  }
  if (t.includes("xml")) {
    return body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n")
      .trim();
  }
  return body.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
}

function buildLlmSteps(flows: Flow[], opts: LlmExportOptions): LlmStep[] {
  const steps: LlmStep[] = [];
  // Cache of decoded prior responses for placeholder lookups.
  const priorResponses: { idx: number; body: string; contentType: string | null }[] = [];
  // Map from value → token, persistent across steps so the same value reuses {varN}.
  const tokenByValue = new Map<string, Placeholder>();
  let nextVar = 1;

  flows.forEach((f, i) => {
    const index = i + 1;
    const url = fullUrl(f);
    const charset = parseCharset(f.reqContentType);
    const headers = maskHeaders(f.reqHeaders, opts.redactSecrets);
    const decodedReq = decodeBody(f.reqBody, f.reqBodyEncoding);
    const decodedRes = decodeBody(f.resBody, f.resBodyEncoding);

    // Detect placeholders by scanning candidate values against prior responses.
    const stepPlaceholders: Placeholder[] = [];
    const substitute = (s: string): string => {
      if (!s) return s;
      let out = s;
      // Look at form values, query params, header values, raw body fragments — but here
      // we handle generically by scanning a list of candidate substrings extracted below.
      return out;
    };

    const collectCandidates = (): string[] => {
      const set = new Set<string>();
      const pushAll = (v: string) => { if (isPlaceholderCandidate(v)) set.add(v); };
      // From form body
      if (f.reqContentType && /x-www-form-urlencoded/i.test(f.reqContentType) && decodedReq) {
        for (const [, v] of parseFormBody(decodedReq)) pushAll(v);
      }
      // From query string
      const q = f.path.includes("?") ? f.path.slice(f.path.indexOf("?") + 1) : "";
      if (q) for (const [, v] of parseFormBody(q)) pushAll(v);
      // From headers
      for (const [, v] of headers) pushAll(v);
      // From JSON body leaves
      if (f.reqContentType && /json/i.test(f.reqContentType) && decodedReq) {
        try {
          const obj = JSON.parse(decodedReq);
          const walk = (o: unknown) => {
            if (o == null) return;
            if (typeof o === "string") { pushAll(o); return; }
            if (Array.isArray(o)) { o.forEach(walk); return; }
            if (typeof o === "object") Object.values(o as Record<string, unknown>).forEach(walk);
          };
          walk(obj);
        } catch { /* not JSON */ }
      }
      return [...set];
    };

    for (const value of collectCandidates()) {
      const existing = tokenByValue.get(value);
      if (existing) {
        if (!stepPlaceholders.find((p) => p.token === existing.token)) {
          stepPlaceholders.push(existing);
        }
        continue;
      }
      // Search prior responses for the value.
      for (const pr of priorResponses) {
        if (pr.body && pr.body.includes(value)) {
          const token = `{var${nextVar++}}`;
          const ph: Placeholder = {
            token,
            value,
            fromStep: pr.idx,
            locator: locatorHint(value, pr.body, pr.contentType),
          };
          tokenByValue.set(value, ph);
          stepPlaceholders.push(ph);
          break;
        }
      }
    }

    const applyTokens = (s: string | null): string => {
      if (!s) return s ?? "";
      let out = s;
      for (const ph of tokenByValue.values()) {
        if (out.includes(ph.value)) {
          out = out.split(ph.value).join(ph.token);
        }
      }
      return out;
    };

    // Body parsing
    let bodyKind: LlmStep["bodyKind"] = "empty";
    let bodyForm: [string, string][] | undefined;
    let bodyJson: string | undefined;
    let bodyRaw: string | undefined;
    let bodyNote: string | undefined;

    if (!decodedReq) {
      bodyKind = "empty";
    } else if (f.reqBodyEncoding === "base64") {
      bodyKind = "binary";
      bodyNote = `binary, ${f.reqSize} bytes${f.reqContentType ? `, ${f.reqContentType}` : ""}`;
    } else if (f.reqContentType && /x-www-form-urlencoded/i.test(f.reqContentType)) {
      bodyKind = "form";
      bodyForm = parseFormBody(decodedReq).map(([k, v]) => [k, applyTokens(v)] as [string, string]);
    } else if (f.reqContentType && /json/i.test(f.reqContentType)) {
      bodyKind = "json";
      try {
        bodyJson = JSON.stringify(JSON.parse(applyTokens(decodedReq)), null, 2);
      } catch {
        bodyKind = "raw";
        bodyRaw = applyTokens(decodedReq);
      }
    } else {
      bodyKind = "raw";
      bodyRaw = applyTokens(decodedReq);
    }

    // URL with token substitution (query string may carry a forwarded token)
    const urlSub = applyTokens(url);

    const step: LlmStep = {
      index,
      name: stepNameFromUrl(f.method, f.path, index),
      method: f.method,
      url: urlSub,
      charset,
      contentType: f.reqContentType,
      headers: headers.map(([k, v]) => [k, applyTokens(v)] as [string, string]),
      bodyKind,
      bodyForm,
      bodyJson,
      bodyRaw,
      bodyNote,
      responseStatus: f.status,
      responseStatusText: f.statusText,
      responseContentType: f.resContentType,
      responseHeaders: maskHeaders(f.resHeaders, opts.redactSecrets),
      responseBody: (opts.includeResponseBodies && decodedRes && f.resBodyEncoding === "utf8" && isTextualContentType(f.resContentType))
        ? compactBody(decodedRes, f.resContentType)
        : undefined,
      durationMs: f.durationMs,
      note: f.note ?? null,
      error: f.error,
      placeholders: stepPlaceholders,
    };
    steps.push(step);

    // Register this step's response so later steps can detect dependencies.
    if (decodedRes && f.resBodyEncoding === "utf8") {
      priorResponses.push({ idx: index, body: decodedRes, contentType: f.resContentType });
    }
    void substitute; // (unused helper kept inline for clarity; tree-shaken)
  });

  return steps;
}

/** Headers (k,v) present identically in every step — hoisted once to cut tokens. */
function commonRequestHeaders(steps: LlmStep[]): Map<string, string> {
  if (steps.length === 0) return new Map();
  const first = new Map<string, string>(steps[0].headers.map(([k, v]) => [k.toLowerCase(), v]));
  // Track display casing from the first occurrence.
  const display = new Map<string, string>(steps[0].headers.map(([k]) => [k.toLowerCase(), k]));
  for (let i = 1; i < steps.length; i++) {
    const cur = new Map<string, string>(steps[i].headers.map(([k, v]) => [k.toLowerCase(), v]));
    for (const k of [...first.keys()]) {
      if (cur.get(k) !== first.get(k)) first.delete(k);
    }
    if (first.size === 0) break;
  }
  // Only worth hoisting if there are at least 2 steps and at least 2 shared headers.
  if (steps.length < 2 || first.size < 2) return new Map();
  return new Map([...first.entries()].map(([k, v]) => [display.get(k) ?? k, v]));
}

function renderStructuredSteps(steps: LlmStep[]): string {
  const out: string[] = [];
  const shared = commonRequestHeaders(steps);
  const sharedKeysLower = new Set([...shared.keys()].map((k) => k.toLowerCase()));

  out.push(
    "## Steps",
    "",
    "_Cada item é uma chamada normalizada. Valores marcados como `{varN}` vêm de respostas de steps anteriores — extraia conforme `placeholders[].locator`. Headers comuns a todas as chamadas estão em `commonRequestHeaders` (anexe a cada chamada)._",
    "",
  );

  if (shared.size > 0) {
    out.push("```yaml");
    out.push("commonRequestHeaders:");
    for (const [k, v] of shared) out.push(`  - ${JSON.stringify([k, v])}`);
    out.push("```");
    out.push("");
  }

  for (const s of steps) {
    out.push(`### Step ${s.index}: ${s.name}`);
    if (s.note) out.push("", `_${s.note}_`);
    out.push("");
    out.push("```yaml");
    out.push(`method: ${s.method}`);
    out.push(`url: ${s.url}`);
    if (s.contentType) out.push(`contentType: ${s.contentType}`);
    if (s.charset) out.push(`charset: ${s.charset}`);
    const localHeaders = s.headers.filter(([k]) => !sharedKeysLower.has(k.toLowerCase()));
    if (localHeaders.length) {
      out.push("headers:");
      for (const [k, v] of localHeaders) out.push(`  - ${JSON.stringify([k, v])}`);
    }
    if (s.bodyForm) {
      out.push("body:");
      for (const [k, v] of s.bodyForm) out.push(`  - ${JSON.stringify([k, v])}`);
    } else if (s.bodyJson) {
      out.push("body: |");
      for (const line of s.bodyJson.split("\n")) out.push(`  ${line}`);
    } else if (s.bodyRaw) {
      out.push("body: |");
      for (const line of s.bodyRaw.split("\n")) out.push(`  ${line}`);
    } else if (s.bodyNote) {
      out.push(`body: ${JSON.stringify(s.bodyNote)}`);
    }
    out.push("response:");
    const statusLine = s.responseStatusText
      ? `${s.responseStatus ?? "null"} ${s.responseStatusText}`
      : `${s.responseStatus ?? "null"}`;
    out.push(`  status: ${statusLine}`);
    if (s.responseContentType) out.push(`  contentType: ${s.responseContentType}`);
    if (s.durationMs != null) out.push(`  durationMs: ${s.durationMs}`);
    if (s.responseHeaders.length) {
      out.push("  headers:");
      for (const [k, v] of s.responseHeaders) out.push(`    - ${JSON.stringify([k, v])}`);
    }
    if (s.responseBody) {
      out.push("  body: |");
      for (const line of s.responseBody.split("\n")) out.push(`    ${line}`);
    }
    if (s.placeholders.length) {
      out.push("placeholders:");
      for (const ph of s.placeholders) {
        out.push(`  - token: ${ph.token}`);
        out.push(`    fromStep: ${ph.fromStep}`);
        out.push(`    locator: ${JSON.stringify(ph.locator)}`);
      }
    }
    if (s.error) out.push(`error: ${JSON.stringify(s.error)}`);
    out.push("```");
    out.push("");
  }
  return out.join("\n");
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
    "",
  );

  if (opts.includeStructuredSteps) {
    const steps = buildLlmSteps(flows, opts);
    out.push(renderStructuredSteps(steps));
  } else {
    out.push("## Fluxo", "");
    flows.forEach((f, i) => {
      const url = fullUrl(f);
      const status = f.status != null ? `${f.status}${f.statusText ? " " + f.statusText : ""}` : "(no response)";
      const dur = f.durationMs != null ? `${f.durationMs} ms` : "—";
      out.push(`### ${i + 1}. ${f.method} ${url}  →  ${status}  (${dur})`);
      if (f.note) out.push("", `**Note:** ${f.note}`);
      out.push("", "**Request headers**", headersTable(maskHeaders(f.reqHeaders, opts.redactSecrets)));
      out.push("**Response headers**", headersTable(maskHeaders(f.resHeaders, opts.redactSecrets)));
      if (opts.includeResponseBodies) {
        const resBodyDecoded = decodeBody(f.resBody, f.resBodyEncoding);
        if (resBodyDecoded && f.resBodyEncoding === "utf8" && isTextualContentType(f.resContentType)) {
          const cleaned = compactBody(resBodyDecoded, f.resContentType);
          const fenceLang = f.resContentType?.includes("json") ? "json"
            : f.resContentType?.includes("html") ? "html"
            : f.resContentType?.includes("xml") ? "xml" : "";
          out.push("**Response body**", "", `\`\`\`${fenceLang}`, cleaned, "```", "");
        }
      }
      if (f.error) out.push(`**Error:** ${f.error}`, "");
      if (i < flows.length - 1) out.push("---", "");
    });
  }

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
