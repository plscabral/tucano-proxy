import type { Flow } from "./types";

const CRLF = "\r\n";

function normalizeVersion(v: string | null | undefined): string {
  if (!v) return "HTTP/1.1";
  if (v.startsWith("HTTP/")) return v;
  const m = v.match(/HTTP\/[\d.]+/);
  return m ? m[0] : "HTTP/1.1";
}

function bodyBlock(body: string | null, encoding: "utf8" | "base64", size: number): string {
  if (body == null || body === "") return "";
  if (encoding === "base64") {
    return `<binary ${size} bytes — base64>${CRLF}${body}`;
  }
  return body;
}

function headerLines(headers: [string, string][]): string {
  return headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
}

export function buildRawRequest(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  const fullUrl = `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
  const requestLine = `${f.method} ${fullUrl} ${normalizeVersion(f.httpVersion)}`;
  const hostInHeaders = f.reqHeaders.some(([k]) => k.toLowerCase() === "host");
  const headers: [string, string][] = hostInHeaders
    ? f.reqHeaders
    : [["Host", defaultHost(f)], ...f.reqHeaders];
  const body = bodyBlock(f.reqBody, f.reqBodyEncoding, f.reqSize);
  return [requestLine, headerLines(headers), "", body].join(CRLF);
}

export function buildRawResponse(f: Flow): string {
  if (f.status == null) return "(no response yet)";
  const statusLine = `${normalizeVersion(f.httpVersion)} ${f.status} ${f.statusText ?? ""}`.trimEnd();
  const body = bodyBlock(f.resBody, f.resBodyEncoding, f.resSize);
  return [statusLine, headerLines(f.resHeaders), "", body].join(CRLF);
}

function defaultHost(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return def ? f.host : `${f.host}:${f.port}`;
}
