import { createSignal, Show, For } from "solid-js";
import { Play, Clock, X, ChevronDown } from "lucide-solid";
import { ipc } from "../lib/ipc";
import type { Flow } from "../lib/types";
import BodyView from "./BodyView";
import HeadersView from "./HeadersView";

type HistoryEntry = { method: string; host: string; path: string; flow: Flow };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function buildUrl(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
}

function parseHeaders(raw: string): [string, string][] {
  return raw.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.includes(":"))
    .map((l) => {
      const idx = l.indexOf(":");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [string, string];
    });
}

function headersToRaw(h: [string, string][]): string {
  return h.map(([k, v]) => `${k}: ${v}`).join("\n");
}

export default function Composer(props: { onClose: () => void; initialFlow?: Flow | null }) {
  const [method, setMethod] = createSignal("GET");
  const [url, setUrl] = createSignal("https://");
  const [headersRaw, setHeadersRaw] = createSignal("User-Agent: Tucano Composer\nAccept: */*");
  const [bodyText, setBodyText] = createSignal("");
  const [tab, setTab] = createSignal<"parsed" | "raw">("parsed");
  const [log, setLog] = createSignal(true);
  const [executing, setExecuting] = createSignal(false);
  const [response, setResponse] = createSignal<Flow | null>(null);
  const [resTab, setResTab] = createSignal<"headers" | "body">("body");
  const [history, setHistory] = createSignal<HistoryEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);

  // Pre-populate from a flow if passed in
  if (props.initialFlow) {
    const f = props.initialFlow;
    setMethod(f.method);
    setUrl(buildUrl(f));
    setHeadersRaw(headersToRaw(f.reqHeaders as [string, string][]));
    setBodyText(f.reqBody ?? "");
  }

  const loadFromHistory = (e: HistoryEntry) => {
    const f = e.flow;
    setMethod(f.method);
    setUrl(buildUrl(f));
    setHeadersRaw(headersToRaw(f.reqHeaders as [string, string][]));
    setBodyText(f.reqBody ?? "");
    setResponse(null);
    setError(null);
  };

  const execute = async () => {
    if (executing()) return;
    setExecuting(true);
    setResponse(null);
    setError(null);
    try {
      const headers = parseHeaders(headersRaw());
      const body = bodyText().trim() || null;
      const flow = await ipc.composeRequest({ method: method(), url: url(), headers, body, log: log() });
      setResponse(flow);
      setHistory((h) => [
        { method: method(), host: flow.host, path: flow.path, flow },
        ...h.slice(0, 19),
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setExecuting(false);
    }
  };

  const btnCls = (active: boolean) =>
    `px-2.5 h-7 text-[11px] rounded-md transition ${active
      ? "bg-toucan-400/15 text-toucan-400 font-medium"
      : "opacity-65 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`;

  return (
    <div data-inspector="true" class="h-full flex flex-col bg-white dark:bg-ink-500 text-ink-500 dark:text-ink-50">
      {/* Header */}
      <div class="flex items-center gap-2 px-4 h-11 border-b border-ink-100 dark:border-ink-400/30 bg-ink-50/60 dark:bg-ink-600 shrink-0">
        <span class="text-xs font-semibold text-toucan-400 uppercase tracking-wider">Composer</span>
        <div class="flex-1" />
        <label class="flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 cursor-pointer">
          <input type="checkbox" checked={log()} onChange={(e) => setLog(e.currentTarget.checked)} />
          Log requests
        </label>
        <button onClick={props.onClose} class="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
          <X size={13} />
        </button>
      </div>

      <div class="flex flex-1 min-h-0">
        {/* Main area */}
        <div class="flex-1 flex flex-col min-h-0 min-w-0">
          {/* URL bar */}
          <div class="flex items-center gap-2 px-3 py-2 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
            {/* Method */}
            <div class="relative">
              <select
                value={method()}
                onChange={(e) => setMethod(e.currentTarget.value)}
                class="appearance-none h-8 pl-3 pr-7 text-xs mono font-semibold rounded-lg bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 hover:border-toucan-400/60 outline-none cursor-pointer"
              >
                <For each={METHODS}>{(m) => <option value={m}>{m}</option>}</For>
              </select>
              <ChevronDown size={11} class="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
            </div>
            {/* URL */}
            <input
              type="text"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") execute(); }}
              placeholder="https://api.example.com/endpoint"
              class="flex-1 h-8 px-3 mono text-xs rounded-lg bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
            />
            {/* Execute */}
            <button
              onClick={execute}
              disabled={executing()}
              class="h-8 px-4 text-xs font-semibold rounded-lg bg-toucan-400 text-ink-500 hover:bg-toucan-300 disabled:opacity-50 flex items-center gap-1.5 transition shrink-0"
            >
              <Play size={12} class={executing() ? "animate-pulse" : ""} />
              {executing() ? "Sending…" : "Execute"}
            </button>
          </div>

          {/* Tab bar */}
          <div class="flex items-center gap-1 px-3 h-9 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-ink-500 shrink-0">
            <button class={btnCls(tab() === "parsed")} onClick={() => setTab("parsed")}>Parsed</button>
            <button class={btnCls(tab() === "raw")} onClick={() => setTab("raw")}>Raw</button>
          </div>

          <Show when={tab() === "parsed"}>
            <div class="flex flex-col flex-1 min-h-0 divide-y divide-ink-100 dark:divide-ink-400/20">
              {/* Headers */}
              <div class="flex flex-col" style={{ "max-height": "40%" }}>
                <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Request Headers</div>
                <textarea
                  value={headersRaw()}
                  onInput={(e) => setHeadersRaw(e.currentTarget.value)}
                  placeholder="Content-Type: application/json&#10;Authorization: Bearer token"
                  class="flex-1 px-3 py-2 mono text-xs bg-ink-50/40 dark:bg-ink-600 resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
                />
              </div>
              {/* Body */}
              <div class="flex flex-col flex-1 min-h-0">
                <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Request Body</div>
                <textarea
                  value={bodyText()}
                  onInput={(e) => setBodyText(e.currentTarget.value)}
                  placeholder='{"key": "value"}'
                  class="flex-1 px-3 py-2 mono text-xs bg-ink-50/40 dark:bg-ink-600 resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
                />
              </div>
            </div>
          </Show>

          <Show when={tab() === "raw"}>
            <div class="flex flex-col flex-1 min-h-0">
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50 shrink-0">Raw HTTP Request</div>
              <textarea
                value={`${method()} ${url().replace(/^https?:\/\/[^/]+/, "") || "/"} HTTP/1.1\n${headersRaw()}\n\n${bodyText()}`}
                onInput={(e) => {
                  // Parse back raw HTTP into fields
                  const lines = e.currentTarget.value.split("\n");
                  const parts = lines[0]?.split(" ") ?? [];
                  if (parts[0]) setMethod(parts[0]);
                  const emptyLine = lines.findIndex((l) => l.trim() === "");
                  const headerLines = lines.slice(1, emptyLine > 0 ? emptyLine : undefined).join("\n");
                  setHeadersRaw(headerLines);
                  if (emptyLine > 0) setBodyText(lines.slice(emptyLine + 1).join("\n"));
                }}
                class="flex-1 px-3 py-2 mono text-xs bg-ink-50/40 dark:bg-ink-600 resize-none outline-none focus:bg-white dark:focus:bg-ink-500 transition"
              />
            </div>
          </Show>

          {/* Response */}
          <Show when={response() || error()}>
            <div class="border-t-2 border-toucan-400/30 flex flex-col min-h-0" style={{ height: "45%" }}>
              <Show when={error()}>
                <div class="p-3 text-xs text-red-400 mono">{error()}</div>
              </Show>
              <Show when={response()}>
                {(f) => (
                  <>
                    <div class="flex items-center gap-2 px-3 h-9 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-ink-500 shrink-0">
                      <span class={`text-xs font-semibold mono ${(f().status ?? 0) >= 400 ? "text-red-400" : (f().status ?? 0) >= 300 ? "text-cyan-300" : "text-emerald-400"}`}>
                        {f().status} {f().statusText}
                      </span>
                      <span class="text-[11px] opacity-50 mono">{f().durationMs}ms · {f().resSize}B</span>
                      <div class="flex-1" />
                      <button class={btnCls(resTab() === "headers")} onClick={() => setResTab("headers")}>Headers</button>
                      <button class={btnCls(resTab() === "body")} onClick={() => setResTab("body")}>Body</button>
                    </div>
                    <div class="flex-1 min-h-0 overflow-auto scroll-thin">
                      <Show when={resTab() === "headers"}>
                        <HeadersView headers={f().resHeaders} />
                      </Show>
                      <Show when={resTab() === "body"}>
                        <BodyView body={f().resBody ?? null} encoding={f().resBodyEncoding as "utf8" | "base64"} contentType={f().resContentType ?? null} />
                      </Show>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </div>

        {/* History sidebar */}
        <div class="w-44 shrink-0 border-l border-ink-100 dark:border-ink-400/30 flex flex-col min-h-0">
          <div class="px-3 py-2 text-[10px] uppercase tracking-wider opacity-50 flex items-center gap-1 shrink-0">
            <Clock size={10} /> History
          </div>
          <div class="flex-1 overflow-auto scroll-thin">
            <For each={history()} fallback={<div class="px-3 py-2 text-[11px] opacity-40">No history yet</div>}>
              {(entry) => (
                <button
                  onClick={() => loadFromHistory(entry)}
                  class="w-full px-3 py-2 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition"
                >
                  <div class="text-[10px] font-semibold mono text-toucan-400/80">{entry.method}</div>
                  <div class="text-[11px] truncate opacity-70">{entry.host}</div>
                  <div class="text-[10px] truncate opacity-50 mono">{entry.path}</div>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
