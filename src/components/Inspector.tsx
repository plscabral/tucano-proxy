import { useMemo, useState } from "react";
import { Copy, Check, ChevronDown, ChevronUp, Clock, Maximize2, Minimize2, EyeOff, X, RotateCcw, Send } from "lucide-react";
import type { Flow } from "@/lib/types";
import HeadersView from "./HeadersView";
import BodyView from "./BodyView";
import TimingView from "./TimingView";
import RawView from "./RawView";
import { buildRawRequest, buildRawResponse } from "@/lib/rawHttp";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";

type SubTab = "headers" | "body" | "raw";
type Focus = "both" | "req" | "res";

function methodColor(m: string) {
  switch (m.toUpperCase()) {
    case "GET":     return "text-emerald-400";
    case "POST":    return "text-cyan-300/80";
    case "PUT":     return "text-amber-400";
    case "PATCH":   return "text-fuchsia-400";
    case "DELETE":  return "text-red-400";
    case "HEAD":    return "text-violet-400";
    case "OPTIONS": return "text-teal-400";
    default:        return "text-toucan-400";
  }
}
function statusColor(s: number | null | undefined) {
  if (s == null) return "opacity-70";
  if (s >= 500) return "text-red-400";
  if (s >= 400) return "text-amber-400";
  if (s >= 300) return "text-cyan-300/80";
  if (s >= 200) return "text-emerald-400";
  return "opacity-70";
}
function buildFullUrl(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
}

export default function Inspector({ flow, onClose, onComposer }: { flow: Flow | null; onClose?: () => void; onComposer?: (flow: Flow) => void }) {
  const [reqTab, setReqTab] = useState<SubTab>("headers");
  const [resTab, setResTab] = useState<SubTab>("body");
  const [showTiming, setShowTiming] = useState(false);
  const [focus, setFocus] = useState<Focus>("both");
  const [urlExpanded, setUrlExpanded] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const fullUrl = useMemo(() => (flow ? buildFullUrl(flow) : ""), [flow]);

  const replay = async () => {
    if (!flow || replaying) return;
    setReplaying(true);
    try { await ipc.replay(flow.id, [], null); }
    catch (e) { console.error("replay failed", e); alert(String(e)); }
    finally { setReplaying(false); }
  };

  const copyUrl = async () => {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1200);
    } catch {}
  };

  return (
    <div data-inspector="true" className="h-full flex flex-col relative bg-[var(--tcn-canvas)]">
      {!flow ? (
        <div className="h-full grid place-items-center opacity-50 text-sm">{t("ins.placeholder")}</div>
      ) : (
        <>
          <div className="px-5 py-3 border-b border-ink-100 dark:border-ink-400/30 space-y-1.5">
            <div className="mono text-sm flex gap-2.5 items-center">
              <span className={`font-semibold ${methodColor(flow.method)}`}>{flow.method}</span>
              {urlExpanded && <span className="truncate flex-1 min-w-0" title={fullUrl}>{flow.path}</span>}
              <span className={`shrink-0 font-semibold ${!urlExpanded ? "ml-auto" : ""} ${statusColor(flow.status)}`}>
                {flow.status ?? "…"} <span className="opacity-70 font-normal">{flow.statusText ?? ""}</span>
              </span>
              <button
                onClick={replay}
                disabled={replaying}
                title="Replay request"
                className="h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 transition shrink-0 opacity-60 hover:opacity-100 hover:bg-toucan-400/10 hover:text-toucan-400 disabled:opacity-30"
              >
                <RotateCcw size={11} className={replaying ? "animate-spin" : ""} /> Replay
              </button>
              {onComposer && (
                <button
                  onClick={() => flow && onComposer(flow)}
                  title="Send to Composer"
                  className="h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 transition shrink-0 opacity-60 hover:opacity-100 hover:bg-toucan-400/10 hover:text-toucan-400"
                >
                  <Send size={11} /> Composer
                </button>
              )}
              <button
                onClick={() => setShowTiming((v) => !v)}
                title={t("ins.tab.timing")}
                className={`h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 transition shrink-0
                  ${showTiming ? "bg-toucan-400/15 text-toucan-400" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
              >
                <Clock size={11} /> {t("ins.tab.timing")}
              </button>
              {onClose && (
                <button
                  onClick={() => onClose()}
                  title={t("ins.close")}
                  className="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition shrink-0"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="flex items-start gap-1.5 group">
              <button
                onClick={() => setUrlExpanded((v) => !v)}
                title={urlExpanded ? t("ins.urlCollapse") : t("ins.urlExpand")}
                className="h-5 w-5 grid place-items-center rounded opacity-50 hover:opacity-100 hover:text-toucan-400 transition shrink-0 mt-0.5"
              >
                {urlExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              <div
                onClick={() => setUrlExpanded((v) => !v)}
                className={`mono text-[11px] flex-1 min-w-0 cursor-pointer leading-relaxed ${
                  urlExpanded ? "break-all opacity-90 select-text" : "truncate opacity-60"
                }`}
                title={!urlExpanded ? fullUrl : undefined}
              >
                {urlExpanded ? (
                  <>
                    <span className="opacity-60">{flow.scheme}://</span>
                    <span className="text-toucan-400">{flow.host}</span>
                    {!((flow.scheme === "https" && flow.port === 443) || (flow.scheme === "http" && flow.port === 80)) && (
                      <span className="opacity-60">:{flow.port}</span>
                    )}
                    <span>{flow.path}</span>
                  </>
                ) : (
                  <span>{flow.scheme}://{flow.host}{(flow.scheme === "https" && flow.port === 443) || (flow.scheme === "http" && flow.port === 80) ? "" : ":" + flow.port}</span>
                )}
              </div>
              <button
                onClick={copyUrl}
                title={t("ins.copyUrl")}
                className="h-6 px-2 rounded-md text-[10px] flex items-center gap-1 opacity-0 group-hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition shrink-0"
              >
                {urlCopied ? <Check size={11} /> : <Copy size={11} />}
              </button>
            </div>
          </div>

          {showTiming ? (
            <div className="flex-1 overflow-auto scroll-thin bg-[var(--tcn-canvas)]">
              <TimingView flow={flow} />
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex divide-x divide-ink-100 dark:divide-ink-400/30">
              {focus !== "res" && (
                <Pane
                  label="Request"
                  accent="text-cyan-300/80"
                  tab={reqTab}
                  onTab={setReqTab}
                  focused={focus === "req"}
                  onToggleFocus={() => setFocus(focus === "req" ? "both" : "req")}
                  onHide={() => setFocus("res")}
                >
                  {reqTab === "headers"
                    ? <HeadersView headers={flow.reqHeaders} />
                    : reqTab === "raw"
                      ? <RawView text={buildRawRequest(flow)} />
                      : <BodyView body={flow.reqBody} encoding={flow.reqBodyEncoding} contentType={flow.reqContentType} />}
                </Pane>
              )}
              {focus !== "req" && (
                <Pane
                  label="Response"
                  accent="text-emerald-400"
                  tab={resTab}
                  onTab={setResTab}
                  focused={focus === "res"}
                  onToggleFocus={() => setFocus(focus === "res" ? "both" : "res")}
                  onHide={() => setFocus("req")}
                >
                  {resTab === "headers"
                    ? <HeadersView headers={flow.resHeaders} />
                    : resTab === "raw"
                      ? <RawView text={buildRawResponse(flow)} />
                      : <BodyView body={flow.resBody} encoding={flow.resBodyEncoding} contentType={flow.resContentType} />}
                </Pane>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Pane({ label, accent, tab, onTab, focused, onToggleFocus, onHide, children }: {
  label: string;
  accent: string;
  tab: SubTab;
  onTab: (t: SubTab) => void;
  focused: boolean;
  onToggleFocus: () => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  const ctrlBtn = "h-7 w-7 grid place-items-center rounded-md opacity-50 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition shrink-0";
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-1 px-3 h-9 border-b border-ink-100 dark:border-white/[0.05] tcn-glass shrink-0">
        <span className={`text-[10px] uppercase tracking-wider font-semibold mr-2 ${accent}`}>{label}</span>
        <SubTabBtn active={tab === "headers"} onClick={() => onTab("headers")}>Headers</SubTabBtn>
        <SubTabBtn active={tab === "body"} onClick={() => onTab("body")}>Body</SubTabBtn>
        <SubTabBtn active={tab === "raw"} onClick={() => onTab("raw")}>Raw</SubTabBtn>
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={onToggleFocus} className={ctrlBtn} title={focused ? "Restore split" : "Maximize"}>
            {focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          {!focused && (
            <button onClick={onHide} className={ctrlBtn} title={`Hide ${label}`}>
              <EyeOff size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scroll-thin bg-[var(--tcn-canvas)]">
        {children}
      </div>
    </div>
  );
}

function SubTabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 h-7 text-[11px] rounded-md transition
        ${active ? "bg-toucan-400/15 text-toucan-400 font-medium" : "opacity-65 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
    >{children}</button>
  );
}
