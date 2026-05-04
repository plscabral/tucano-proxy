import { createMemo, createSignal, Show } from "solid-js";
import { Copy, Check, ChevronDown, ChevronUp, Clock, Maximize2, Minimize2, EyeOff, X } from "lucide-solid";
import type { Flow } from "../lib/types";
import HeadersView from "./HeadersView";
import BodyView from "./BodyView";
import TimingView from "./TimingView";
import { t } from "../lib/i18n";

type SubTab = "headers" | "body";
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

export default function Inspector(props: { flow: Flow | null; onClose?: () => void }) {
  const [reqTab, setReqTab] = createSignal<SubTab>("headers");
  const [resTab, setResTab] = createSignal<SubTab>("body");
  const [showTiming, setShowTiming] = createSignal(false);
  const [focus, setFocus] = createSignal<Focus>("both");
  const [urlExpanded, setUrlExpanded] = createSignal(false);
  const [urlCopied, setUrlCopied] = createSignal(false);

  const fullUrl = createMemo(() => (props.flow ? buildFullUrl(props.flow) : ""));

  const copyUrl = async () => {
    if (!fullUrl()) return;
    try {
      await navigator.clipboard.writeText(fullUrl());
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1200);
    } catch {}
  };

  return (
    <div data-inspector="true" class="h-full flex flex-col">
      <Show when={props.flow} fallback={
        <div class="h-full grid place-items-center opacity-50 text-sm">{t("ins.placeholder")}</div>
      }>
        {(f) => (
          <>
            <div class="px-5 py-3 border-b border-ink-100 dark:border-ink-400/30 space-y-1.5">
              <div class="mono text-sm flex gap-2.5 items-center">
                <span class={`font-semibold ${methodColor(f().method)}`}>{f().method}</span>
                <Show when={!urlExpanded()} fallback={null}>
                  <span class="truncate flex-1 min-w-0" title={fullUrl()}>{f().path}</span>
                </Show>
                <span class={`shrink-0 font-semibold ${!urlExpanded() ? "ml-auto" : ""} ${statusColor(f().status)}`}>
                  {f().status ?? "…"} <span class="opacity-70 font-normal">{f().statusText ?? ""}</span>
                </span>
                <button
                  onClick={() => setShowTiming((v) => !v)}
                  title={t("ins.tab.timing")}
                  class={`h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 transition shrink-0
                    ${showTiming()
                      ? "bg-toucan-400/15 text-toucan-400"
                      : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
                >
                  <Clock size={11} /> {t("ins.tab.timing")}
                </button>
                <Show when={props.onClose}>
                  <button
                    onClick={() => props.onClose?.()}
                    title={t("ins.close")}
                    class="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition shrink-0"
                  >
                    <X size={13} />
                  </button>
                </Show>
              </div>

              <div class="flex items-start gap-1.5 group">
                <button
                  onClick={() => setUrlExpanded((v) => !v)}
                  title={urlExpanded() ? t("ins.urlCollapse") : t("ins.urlExpand")}
                  class="h-5 w-5 grid place-items-center rounded opacity-50 hover:opacity-100 hover:text-toucan-400 transition shrink-0 mt-0.5"
                >
                  {urlExpanded() ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                <div
                  onClick={() => setUrlExpanded((v) => !v)}
                  class={`mono text-[11px] flex-1 min-w-0 cursor-pointer leading-relaxed ${
                    urlExpanded() ? "break-all opacity-90 select-text" : "truncate opacity-60"
                  }`}
                  title={!urlExpanded() ? fullUrl() : undefined}
                >
                  <Show
                    when={urlExpanded()}
                    fallback={<span>{f().scheme}://{f().host}{(f().scheme === "https" && f().port === 443) || (f().scheme === "http" && f().port === 80) ? "" : ":" + f().port}</span>}
                  >
                    <span class="opacity-60">{f().scheme}://</span>
                    <span class="text-toucan-400">{f().host}</span>
                    <Show when={!((f().scheme === "https" && f().port === 443) || (f().scheme === "http" && f().port === 80))}>
                      <span class="opacity-60">:{f().port}</span>
                    </Show>
                    <span>{f().path}</span>
                  </Show>
                </div>
                <button
                  onClick={copyUrl}
                  title={t("ins.copyUrl")}
                  class="h-6 px-2 rounded-md text-[10px] flex items-center gap-1 opacity-0 group-hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition shrink-0"
                >
                  {urlCopied() ? <Check size={11} /> : <Copy size={11} />}
                </button>
              </div>
            </div>

            <Show
              when={!showTiming()}
              fallback={
                <div class="flex-1 overflow-auto scroll-thin bg-ink-50/40 dark:bg-ink-600">
                  <TimingView flow={f()} />
                </div>
              }
            >
              <div class="flex-1 min-h-0 flex divide-x divide-ink-100 dark:divide-ink-400/30">
                <Show when={focus() !== "res"}>
                  <Pane
                    label="Request"
                    accent="text-cyan-300/80"
                    tab={reqTab()}
                    onTab={setReqTab}
                    focused={focus() === "req"}
                    onToggleFocus={() => setFocus(focus() === "req" ? "both" : "req")}
                    onHide={() => setFocus("res")}
                  >
                    {reqTab() === "headers"
                      ? <HeadersView headers={f().reqHeaders} />
                      : <BodyView body={f().reqBody} encoding={f().reqBodyEncoding} contentType={f().reqContentType} />}
                  </Pane>
                </Show>
                <Show when={focus() !== "req"}>
                  <Pane
                    label="Response"
                    accent="text-emerald-400"
                    tab={resTab()}
                    onTab={setResTab}
                    focused={focus() === "res"}
                    onToggleFocus={() => setFocus(focus() === "res" ? "both" : "res")}
                    onHide={() => setFocus("req")}
                  >
                    {resTab() === "headers"
                      ? <HeadersView headers={f().resHeaders} />
                      : <BodyView body={f().resBody} encoding={f().resBodyEncoding} contentType={f().resContentType} />}
                  </Pane>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function Pane(props: {
  label: string;
  accent: string;
  tab: SubTab;
  onTab: (t: SubTab) => void;
  focused: boolean;
  onToggleFocus: () => void;
  onHide: () => void;
  children: any;
}) {
  const ctrlBtn = "h-7 w-7 grid place-items-center rounded-md opacity-50 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition shrink-0";
  return (
    <div class="flex-1 flex flex-col min-w-0 min-h-0">
      <div class="flex items-center gap-1 px-3 h-9 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-ink-500 shrink-0">
        <span class={`text-[10px] uppercase tracking-wider font-semibold mr-2 ${props.accent}`}>{props.label}</span>
        <SubTabBtn active={props.tab === "headers"} onClick={() => props.onTab("headers")}>Headers</SubTabBtn>
        <SubTabBtn active={props.tab === "body"} onClick={() => props.onTab("body")}>Body</SubTabBtn>
        <div class="ml-auto flex items-center gap-0.5">
          <button
            onClick={props.onToggleFocus}
            class={ctrlBtn}
            title={props.focused ? "Restore split" : "Maximize"}
          >
            {props.focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <Show when={!props.focused}>
            <button onClick={props.onHide} class={ctrlBtn} title={`Hide ${props.label}`}>
              <EyeOff size={12} />
            </button>
          </Show>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-auto scroll-thin bg-ink-50/40 dark:bg-ink-600">
        {props.children}
      </div>
    </div>
  );
}

function SubTabBtn(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      onClick={props.onClick}
      class={`px-2.5 h-7 text-[11px] rounded-md transition
        ${props.active
          ? "bg-toucan-400/15 text-toucan-400 font-medium"
          : "opacity-65 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
    >{props.children}</button>
  );
}
