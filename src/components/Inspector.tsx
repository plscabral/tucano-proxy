import { createMemo, createSignal, Show } from "solid-js";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-solid";
import type { Flow } from "../lib/types";
import HeadersView from "./HeadersView";
import BodyView from "./BodyView";
import TimingView from "./TimingView";
import { t } from "../lib/i18n";

type Tab = "req-headers" | "req-body" | "res-headers" | "res-body" | "timing";

function buildFullUrl(f: Flow): string {
  const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
}

export default function Inspector(props: { flow: Flow | null }) {
  const [tab, setTab] = createSignal<Tab>("res-body");
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

  const tabs: { id: Tab; key: string }[] = [
    { id: "req-headers", key: "ins.tab.reqHeaders" },
    { id: "req-body",    key: "ins.tab.reqBody" },
    { id: "res-headers", key: "ins.tab.resHeaders" },
    { id: "res-body",    key: "ins.tab.resBody" },
    { id: "timing",      key: "ins.tab.timing" },
  ];

  return (
    <div class="h-full flex flex-col">
      <Show when={props.flow} fallback={
        <div class="h-full grid place-items-center opacity-50 text-sm">{t("ins.placeholder")}</div>
      }>
        {(f) => (
          <>
            <div class="px-5 py-3 border-b border-ink-100 dark:border-ink-400/30 space-y-1.5">
              {/* Method + status (URL preview goes below, stays prominent) */}
              <div class="mono text-sm flex gap-2.5 items-center">
                <span class="font-semibold text-toucan-400">{f().method}</span>
                <Show when={!urlExpanded()} fallback={null}>
                  <span class="truncate flex-1 min-w-0" title={fullUrl()}>{f().path}</span>
                </Show>
                <span class={`opacity-70 shrink-0 ${!urlExpanded() ? "ml-auto" : ""}`}>
                  {f().status ?? "…"} {f().statusText ?? ""}
                </span>
              </div>

              {/* Full URL row — collapsed shows host only with expand affordance.
                  Expanded shows the entire scheme://host:port/path?query wrapped
                  across as many lines as needed, fully selectable. */}
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

            <div class="flex gap-1.5 px-3 pt-2.5 pb-0 border-b border-ink-100 dark:border-ink-400/30 bg-white dark:bg-ink-500">
              {tabs.map((tab2) => (
                <button
                  onClick={() => setTab(tab2.id)}
                  class={`px-3.5 h-9 text-xs rounded-t-xl transition
                    ${tab() === tab2.id
                      ? "bg-ink-50 dark:bg-ink-600 text-toucan-400 border-b-2 border-toucan-400 -mb-px font-medium"
                      : "opacity-70 hover:opacity-100"}`}
                >{t(tab2.key)}</button>
              ))}
            </div>

            <div class="flex-1 overflow-auto scroll-thin bg-ink-50/40 dark:bg-ink-600">
              {tab() === "req-headers" && <HeadersView headers={f().reqHeaders} />}
              {tab() === "res-headers" && <HeadersView headers={f().resHeaders} />}
              {tab() === "req-body" && (
                <BodyView body={f().reqBody} encoding={f().reqBodyEncoding} contentType={f().reqContentType} />
              )}
              {tab() === "res-body" && (
                <BodyView body={f().resBody} encoding={f().resBodyEncoding} contentType={f().resContentType} />
              )}
              {tab() === "timing" && <TimingView flow={f()} />}
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
