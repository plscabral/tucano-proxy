import { createSignal, Show } from "solid-js";
import type { Flow } from "../lib/types";
import HeadersView from "./HeadersView";
import BodyView from "./BodyView";
import TimingView from "./TimingView";
import { t } from "../lib/i18n";

type Tab = "req-headers" | "req-body" | "res-headers" | "res-body" | "timing";

export default function Inspector(props: { flow: Flow | null }) {
  const [tab, setTab] = createSignal<Tab>("res-body");
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
            <div class="px-5 py-3 border-b border-ink-100 dark:border-ink-400/30 space-y-1">
              <div class="mono text-[11px] opacity-60">{f().scheme}://{f().host}{f().port !== 443 && f().port !== 80 ? ":" + f().port : ""}</div>
              <div class="mono text-sm flex gap-2.5 items-center">
                <span class="font-semibold text-toucan-400">{f().method}</span>
                <span class="truncate">{f().path}</span>
                <span class="ml-auto opacity-70 shrink-0">{f().status ?? "…"} {f().statusText ?? ""}</span>
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
