import { useState } from "react";
import { Play, Clock, X, ChevronDown, Terminal, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { canMutate, useConnection } from "@/lib/platform";
import type { Flow } from "@/lib/types";
import BodyView from "./BodyView";
import HeadersView from "./HeadersView";

type HistoryEntry = { method: string; host: string; path: string; flow: Flow };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function buildUrl(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  const host = f.host.includes(":") && !f.host.startsWith("[") ? `[${f.host}]` : f.host;
  return `${f.scheme}://${host}${def ? "" : ":" + f.port}${f.path}`;
}
function parseHeaders(raw: string): [string, string][] {
  return raw.split("\n").filter((line) => line.trim()).map((line) => {
    const index = line.indexOf(":");
    if (index <= 0) throw new Error("Invalid HTTP header. Use Header-Name: value.");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string];
  });
}
function headersToRaw(h: [string, string][]): string {
  return h.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function parseRawRequest(raw: string, baseUrl: string) {
  const lines = raw.split("\n");
  const first = /^(\S+)\s+(\S+)\s+HTTP\/1\.[01]\r?$/.exec(lines[0] ?? "");
  if (!first) throw new Error("Use a request line such as POST /path HTTP/1.1.");
  let target: URL;
  try {
    target = /^https?:\/\//i.test(first[2]) ? new URL(first[2]) : new URL(first[2], baseUrl);
  } catch {
    throw new Error("Enter a complete HTTP(S) URL, or set the URL bar before using a relative request path.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Only HTTP(S) request URLs are supported.");
  const separator = lines.findIndex((line, index) => index > 0 && line.trim() === "");
  return {
    method: first[1],
    url: target.href,
    headersRaw: lines.slice(1, separator < 0 ? undefined : separator).join("\n"),
    bodyText: separator < 0 ? "" : lines.slice(separator + 1).join("\n"),
  };
}

export default function Composer({ onClose, initialFlow }: { onClose: () => void; initialFlow?: Flow | null }) {
  useConnection();
  const [method, setMethod] = useState(initialFlow?.method ?? "GET");
  const [url, setUrl] = useState(initialFlow ? buildUrl(initialFlow) : "https://");
  const [headersRaw, setHeadersRaw] = useState(initialFlow ? headersToRaw(initialFlow.reqHeaders) : "User-Agent: Tucano Composer\nAccept: */*");
  const [bodyText, setBodyText] = useState(initialFlow?.reqBody ?? "");
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [log, setLog] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [response, setResponse] = useState<Flow | null>(null);
  const [resTab, setResTab] = useState<"headers" | "body">("body");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadFromHistory = (e: HistoryEntry) => {
    const f = e.flow;
    setMethod(f.method);
    setUrl(buildUrl(f));
    setHeadersRaw(headersToRaw(f.reqHeaders));
    setBodyText(f.reqBody ?? "");
    setRawDraft(null);
    setResponse(null);
    setError(null);
  };

  const execute = async () => {
    if (executing || !canMutate()) return;
    setExecuting(true);
    setResponse(null);
    setError(null);
    try {
      const request = rawDraft === null ? { method, url, headersRaw, bodyText } : parseRawRequest(rawDraft, url);
      if (initialFlow && (initialFlow.reqBodyEncoding === "base64" || initialFlow.reqTruncated) && request.bodyText === initialFlow.reqBody) {
        throw new Error("This captured body is binary or truncated. Supply an explicit text replacement; use Replay to send a complete original binary body.");
      }
      const headers = parseHeaders(request.headersRaw);
      const body = request.bodyText.length ? request.bodyText : null;
      const flow = await ipc.composeRequest({ method: request.method, url: request.url, headers, body, log });
      setResponse(flow);
      setHistory((h) => [{ method: request.method, host: flow.host, path: flow.path, flow }, ...h.slice(0, 19)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setExecuting(false);
    }
  };

  const btnCls = (active: boolean) =>
    `px-2.5 h-7 text-[11px] rounded-md transition ${active ? "bg-toucan-400/15 text-toucan-400 font-medium" : "opacity-65 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-white/[0.06]"}`;

  const status = response?.status ?? 0;
  const statusColor = status >= 400 ? "text-red-400" : status >= 300 ? "text-cyan-300" : "text-emerald-400";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        data-inspector="true"
        onClick={(e) => e.stopPropagation()}
        className="w-[1140px] max-w-[95vw] h-[760px] max-h-[92vh] flex flex-col rounded-2xl bg-white dark:bg-[var(--tcn-canvas)] text-ink-500 dark:text-ink-50 border border-ink-100 dark:border-white/10 shadow-2xl overflow-hidden"
      >
        {/* Header — branded, matches Settings */}
        <div className="relative shrink-0 border-b border-ink-100 dark:border-white/10 overflow-hidden">
          <div className="absolute inset-0 tcn-grid opacity-50 pointer-events-none" />
          <div className="absolute inset-0 tcn-glow-radial pointer-events-none" />
          <div className="relative flex items-center gap-3 px-5 h-16">
            <div className="w-9 h-9 grid place-items-center rounded-xl tcn-sheen ring-1 ring-inset ring-ink-200/50 dark:ring-white/10 shadow-soft">
              <Terminal size={18} className="text-toucan-400" />
            </div>
            <div className="leading-none">
              <div className="font-bold tracking-tight text-base">Composer</div>
              <div className="text-[11px] opacity-50 mt-1.5">Build, send and inspect a request</div>
            </div>
            <div className="flex-1" />
            <label className="flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 cursor-pointer">
              <input type="checkbox" checked={log} onChange={(e) => setLog(e.currentTarget.checked)} className="accent-toucan-400" />
              Log requests
            </label>
            <button aria-label="Close composer" onClick={onClose} className="h-8 w-8 grid place-items-center rounded-lg opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-white/10 transition"><X size={18} /></button>
          </div>
        </div>

        {/* URL bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-ink-100 dark:border-white/10 shrink-0">
          <div className="relative shrink-0">
            <select
              aria-label="HTTP method"
              value={method}
              onChange={(e) => { setMethod(e.currentTarget.value); setRawDraft(null); }}
              className="appearance-none h-9 pl-3.5 pr-8 text-xs mono font-semibold rounded-xl bg-transparent border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 outline-none cursor-pointer"
            >
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
          </div>
          <input
            type="text"
            aria-label="Request URL"
            value={url}
            onChange={(e) => { setUrl(e.currentTarget.value); setRawDraft(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") execute(); }}
            placeholder="https://api.example.com/endpoint"
            className="flex-1 h-9 px-3.5 mono text-xs rounded-xl bg-transparent border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
          />
          <button
            onClick={execute}
            disabled={executing || !canMutate()}
            className="h-9 px-5 text-xs font-semibold rounded-xl tcn-accent tcn-accent-glow disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            <Play size={12} className={executing ? "animate-pulse" : ""} />
            {executing ? "Sending…" : "Execute"}
          </button>
        </div>

        {/* Body — three clear regions: Request | Response | History */}
        <div className="flex flex-1 min-h-0">
          {/* REQUEST */}
          <section className="flex flex-col flex-1 min-w-0 border-r border-ink-100 dark:border-white/10">
            <div className="flex items-center gap-2 px-4 h-9 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
              <ArrowUpRight size={13} className="text-toucan-400" />
              <span className="text-[10px] uppercase tracking-wider font-semibold text-toucan-400">Request</span>
            </div>

            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Raw HTTP request</div>
              <textarea
                aria-label="Raw HTTP request"
                value={rawDraft ?? `${method} ${url.replace(/^https?:\/\/[^/]+/, "") || "/"} HTTP/1.1\n${headersRaw}\n\n${bodyText}`}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  setRawDraft(next);
                  try {
                    const parsed = parseRawRequest(next, url);
                    setMethod(parsed.method);
                    setUrl(parsed.url);
                    setHeadersRaw(parsed.headersRaw);
                    setBodyText(parsed.bodyText);
                  } catch {
                    // Preserve incomplete edits verbatim; Execute reports invalid requests.
                  }
                }}
                spellCheck={false}
                className="flex-1 min-h-0 px-4 pb-3 mono text-xs bg-transparent resize-none outline-none scroll-thin"
              />
            </div>
          </section>

          {/* RESPONSE */}
          <section className="flex flex-col flex-1 min-w-0 border-r border-ink-100 dark:border-white/10">
            <div className="flex items-center gap-2 px-4 h-9 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
              <ArrowDownLeft size={13} className="text-toucan-400" />
              <span className="text-[10px] uppercase tracking-wider font-semibold text-toucan-400">Response</span>
              <div className="flex-1" />
              {response && (
                <>
                  <button className={btnCls(resTab === "headers")} onClick={() => setResTab("headers")}>Headers</button>
                  <button className={btnCls(resTab === "body")} onClick={() => setResTab("body")}>Body</button>
                </>
              )}
            </div>

            {error ? (
              <div className="p-4 text-xs text-red-400 mono whitespace-pre-wrap overflow-auto scroll-thin">{error}</div>
            ) : executing ? (
              <div className="flex-1 grid place-items-center text-xs opacity-50">
                <span className="flex items-center gap-2"><Play size={13} className="animate-pulse" /> Sending request…</span>
              </div>
            ) : response ? (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="flex items-center gap-2 px-4 h-9 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
                  <span className={`text-xs font-semibold mono ${statusColor}`}>{response.status} {response.statusText}</span>
                  <span className="text-[11px] opacity-50 mono">{response.durationMs}ms · {response.resSize}B</span>
                </div>
                <div className="flex-1 min-h-0 overflow-auto scroll-thin">
                  {resTab === "headers"
                    ? <HeadersView headers={response.resHeaders} />
                    : <BodyView body={response.resBody ?? null} encoding={response.resBodyEncoding} contentType={response.resContentType ?? null} />}
                </div>
              </div>
            ) : (
              <div className="flex-1 grid place-items-center text-xs opacity-40 px-6 text-center">
                Run a request to see the response here.
              </div>
            )}
          </section>

          {/* HISTORY */}
          <aside className="w-52 shrink-0 flex flex-col min-h-0">
            <div className="flex items-center gap-1.5 px-4 h-9 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
              <Clock size={11} className="opacity-60" />
              <span className="text-[10px] uppercase tracking-wider font-semibold opacity-50">History</span>
            </div>
            <div className="flex-1 overflow-auto scroll-thin">
              {history.length === 0 ? (
                <div className="px-4 py-3 text-[11px] opacity-40">No history yet</div>
              ) : history.map((entry, i) => (
                <button key={i} onClick={() => loadFromHistory(entry)} className="w-full px-4 py-2.5 text-left border-b border-ink-100 dark:border-ink-400/20 hover:bg-toucan-400/10 hover:text-toucan-400 transition">
                  <div className="text-[10px] font-semibold mono text-toucan-400/80">{entry.method}</div>
                  <div className="text-[11px] truncate opacity-70">{entry.host}</div>
                  <div className="text-[10px] truncate opacity-50 mono">{entry.path}</div>
                </button>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
