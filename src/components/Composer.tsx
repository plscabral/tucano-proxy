import { useState } from "react";
import { Play, Clock, X, ChevronDown } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { Flow } from "@/lib/types";
import BodyView from "./BodyView";
import HeadersView from "./HeadersView";

type HistoryEntry = { method: string; host: string; path: string; flow: Flow };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function buildUrl(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
}
function parseHeaders(raw: string): [string, string][] {
  return raw.split("\n").map((l) => l.trim()).filter((l) => l && l.includes(":")).map((l) => {
    const idx = l.indexOf(":");
    return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [string, string];
  });
}
function headersToRaw(h: [string, string][]): string {
  return h.map(([k, v]) => `${k}: ${v}`).join("\n");
}

export default function Composer({ onClose, initialFlow }: { onClose: () => void; initialFlow?: Flow | null }) {
  const [method, setMethod] = useState(initialFlow?.method ?? "GET");
  const [url, setUrl] = useState(initialFlow ? buildUrl(initialFlow) : "https://");
  const [headersRaw, setHeadersRaw] = useState(initialFlow ? headersToRaw(initialFlow.reqHeaders) : "User-Agent: Tucano Composer\nAccept: */*");
  const [bodyText, setBodyText] = useState(initialFlow?.reqBody ?? "");
  const [tab, setTab] = useState<"parsed" | "raw">("parsed");
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
    setResponse(null);
    setError(null);
  };

  const execute = async () => {
    if (executing) return;
    setExecuting(true);
    setResponse(null);
    setError(null);
    try {
      const headers = parseHeaders(headersRaw);
      const body = bodyText.trim() || null;
      const flow = await ipc.composeRequest({ method, url, headers, body, log });
      setResponse(flow);
      setHistory((h) => [{ method, host: flow.host, path: flow.path, flow }, ...h.slice(0, 19)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setExecuting(false);
    }
  };

  const btnCls = (active: boolean) =>
    `px-2.5 h-7 text-[11px] rounded-md transition ${active ? "bg-toucan-400/15 text-toucan-400 font-medium" : "opacity-65 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`;

  return (
    <div data-inspector="true" className="h-full flex flex-col bg-white dark:bg-[#000000] text-ink-500 dark:text-ink-50">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-ink-100 dark:border-ink-400/30 bg-ink-50 dark:bg-[#000000] shrink-0">
        <span className="text-xs font-semibold text-toucan-400 uppercase tracking-wider">Composer</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 cursor-pointer">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.currentTarget.checked)} />
          Log requests
        </label>
        <button onClick={onClose} className="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
            <div className="relative">
              <select
                value={method}
                onChange={(e) => setMethod(e.currentTarget.value)}
                className="appearance-none h-8 pl-3 pr-7 text-xs mono font-semibold rounded-lg bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 hover:border-toucan-400/60 outline-none cursor-pointer"
              >
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
            </div>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") execute(); }}
              placeholder="https://api.example.com/endpoint"
              className="flex-1 h-8 px-3 mono text-xs rounded-lg bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
            />
            <button
              onClick={execute}
              disabled={executing}
              className="h-8 px-4 text-xs font-semibold rounded-lg bg-toucan-400 text-white hover:bg-toucan-300 disabled:opacity-50 flex items-center gap-1.5 transition shrink-0"
            >
              <Play size={12} className={executing ? "animate-pulse" : ""} />
              {executing ? "Sending…" : "Execute"}
            </button>
          </div>

          <div className="flex items-center gap-1 px-3 h-9 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-[#000000] shrink-0">
            <button className={btnCls(tab === "parsed")} onClick={() => setTab("parsed")}>Parsed</button>
            <button className={btnCls(tab === "raw")} onClick={() => setTab("raw")}>Raw</button>
          </div>

          {tab === "parsed" && (
            <div className="flex flex-col flex-1 min-h-0 divide-y divide-ink-100 dark:divide-ink-400/20">
              <div className="flex flex-col" style={{ maxHeight: "40%" }}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Request Headers</div>
                <textarea
                  value={headersRaw}
                  onChange={(e) => setHeadersRaw(e.currentTarget.value)}
                  placeholder={"Content-Type: application/json\nAuthorization: Bearer token"}
                  className="flex-1 px-3 py-2 mono text-xs bg-white dark:bg-[#000000] resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
                />
              </div>
              <div className="flex flex-col flex-1 min-h-0">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Request Body</div>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.currentTarget.value)}
                  placeholder={'{"key": "value"}'}
                  className="flex-1 px-3 py-2 mono text-xs bg-white dark:bg-[#000000] resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
                />
              </div>
            </div>
          )}

          {tab === "raw" && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Raw HTTP Request</div>
              <textarea
                value={`${method} ${url.replace(/^https?:\/\/[^/]+/, "") || "/"} HTTP/1.1\n${headersRaw}\n\n${bodyText}`}
                onChange={(e) => {
                  const lines = e.currentTarget.value.split("\n");
                  const parts = lines[0]?.split(" ") ?? [];
                  if (parts[0]) setMethod(parts[0]);
                  const emptyLine = lines.findIndex((l) => l.trim() === "");
                  const headerLines = lines.slice(1, emptyLine > 0 ? emptyLine : undefined).join("\n");
                  setHeadersRaw(headerLines);
                  if (emptyLine > 0) setBodyText(lines.slice(emptyLine + 1).join("\n"));
                }}
                className="flex-1 px-3 py-2 mono text-xs bg-white dark:bg-[#000000] resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
              />
            </div>
          )}

          {(response || error) && (
            <div className="border-t-2 border-toucan-400/30 flex flex-col min-h-0" style={{ height: "45%" }}>
              {error && <div className="p-3 text-xs text-red-400 mono">{error}</div>}
              {response && (
                <>
                  <div className="flex items-center gap-2 px-3 h-9 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-[#000000] shrink-0">
                    <span className={`text-xs font-semibold mono ${(response.status ?? 0) >= 400 ? "text-red-400" : (response.status ?? 0) >= 300 ? "text-cyan-300" : "text-emerald-400"}`}>
                      {response.status} {response.statusText}
                    </span>
                    <span className="text-[11px] opacity-50 mono">{response.durationMs}ms · {response.resSize}B</span>
                    <div className="flex-1" />
                    <button className={btnCls(resTab === "headers")} onClick={() => setResTab("headers")}>Headers</button>
                    <button className={btnCls(resTab === "body")} onClick={() => setResTab("body")}>Body</button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto scroll-thin">
                    {resTab === "headers"
                      ? <HeadersView headers={response.resHeaders} />
                      : <BodyView body={response.resBody ?? null} encoding={response.resBodyEncoding} contentType={response.resContentType ?? null} />}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="w-44 shrink-0 border-l border-ink-100 dark:border-ink-400/30 flex flex-col min-h-0">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider opacity-50 flex items-center gap-1 shrink-0">
            <Clock size={10} /> History
          </div>
          <div className="flex-1 overflow-auto scroll-thin">
            {history.length === 0 ? (
              <div className="px-3 py-2 text-[11px] opacity-40">No history yet</div>
            ) : history.map((entry, i) => (
              <button key={i} onClick={() => loadFromHistory(entry)} className="w-full px-3 py-2 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition">
                <div className="text-[10px] font-semibold mono text-toucan-400/80">{entry.method}</div>
                <div className="text-[11px] truncate opacity-70">{entry.host}</div>
                <div className="text-[10px] truncate opacity-50 mono">{entry.path}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
