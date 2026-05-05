import { createMemo, createSignal, For, Show } from "solid-js";
import { X, ArrowLeftRight, GitCompareArrows } from "lucide-solid";
import type { Flow } from "../lib/types";
import { diffHeaders, diffBody, type HeaderDiffRow } from "../lib/diff";
import { t } from "../lib/i18n";

type Section = "meta" | "reqHeaders" | "reqBody" | "resHeaders" | "resBody";

export default function CompareView(props: { a: Flow; b: Flow; onClose: () => void }) {
  const [a, setA] = createSignal<Flow>(props.a);
  const [b, setB] = createSignal<Flow>(props.b);
  const swap = () => { const x = a(); setA(b()); setB(x); };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
  };

  return (
    <div
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col"
      onKeyDown={onKey}
      tabIndex={-1}
      ref={(el) => queueMicrotask(() => el?.focus())}
    >
      <div class="m-4 flex-1 min-h-0 rounded-2xl bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 shadow-2xl flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
          <GitCompareArrows size={14} class="text-toucan-400" />
          <span class="text-sm font-semibold">{t("compare.title") || "Compare"}</span>
          <div class="flex-1" />
          <button
            onClick={swap}
            title={t("compare.swap") || "Swap A ↔ B"}
            class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
          >
            <ArrowLeftRight size={13} /> {t("compare.swap") || "Swap"}
          </button>
          <button
            onClick={props.onClose}
            class="h-8 w-8 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20"
          >
            <X size={14} />
          </button>
        </div>

        <div class="grid grid-cols-2 gap-px bg-ink-100 dark:bg-ink-400/30 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
          <FlowSummary label="A" tone="text-rose-400" flow={a()} />
          <FlowSummary label="B" tone="text-emerald-400" flow={b()} />
        </div>

        <div class="flex-1 min-h-0 overflow-auto scroll-thin bg-ink-50/40 dark:bg-ink-600">
          <Section title={t("compare.meta") || "Request line / metadata"} initialOpen>
            <MetaTable a={a()} b={b()} />
          </Section>
          <Section title={t("compare.reqHeaders") || "Request headers"} initialOpen>
            <HeaderDiffTable rows={diffHeaders(a().reqHeaders, b().reqHeaders)} />
          </Section>
          <Section title={t("compare.reqBody") || "Request body"} initialOpen>
            <BodyDiff a={a().reqBody} b={b().reqBody} contentType={a().reqContentType ?? b().reqContentType} />
          </Section>
          <Section title={t("compare.resHeaders") || "Response headers"}>
            <HeaderDiffTable rows={diffHeaders(a().resHeaders, b().resHeaders)} />
          </Section>
          <Section title={t("compare.resBody") || "Response body"}>
            <BodyDiff a={a().resBody} b={b().resBody} contentType={a().resContentType ?? b().resContentType} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function FlowSummary(props: { label: string; tone: string; flow: Flow }) {
  const url = () => {
    const f = props.flow;
    const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
    return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
  };
  return (
    <div class="bg-white dark:bg-ink-500 px-4 py-2.5">
      <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider mb-1">
        <span class={`font-semibold ${props.tone}`}>{props.label}</span>
        <span class="opacity-50">#{props.flow.index}</span>
      </div>
      <div class="mono text-xs flex items-center gap-2">
        <span class="font-semibold">{props.flow.method}</span>
        <span class="opacity-70">{props.flow.status ?? "…"}</span>
        <span class="truncate" title={url()}>{url()}</span>
      </div>
    </div>
  );
}

function Section(props: { title: string; initialOpen?: boolean; children: any }) {
  const [open, setOpen] = createSignal(props.initialOpen ?? false);
  return (
    <div class="border-b border-ink-100 dark:border-ink-400/30">
      <button
        onClick={() => setOpen(!open())}
        class="w-full px-4 py-2 text-left text-xs uppercase tracking-wider font-semibold opacity-70 hover:opacity-100 hover:bg-toucan-400/5 transition flex items-center gap-2"
      >
        <span class="opacity-60">{open() ? "▾" : "▸"}</span> {props.title}
      </button>
      <Show when={open()}>
        <div class="bg-white dark:bg-ink-500">{props.children}</div>
      </Show>
    </div>
  );
}

function MetaTable(props: { a: Flow; b: Flow }) {
  const rows: { label: string; a: string; b: string }[] = [
    { label: "method", a: props.a.method, b: props.b.method },
    { label: "scheme", a: props.a.scheme, b: props.b.scheme },
    { label: "host", a: props.a.host, b: props.b.host },
    { label: "port", a: String(props.a.port), b: String(props.b.port) },
    { label: "path", a: props.a.path, b: props.b.path },
    { label: "httpVersion", a: props.a.httpVersion, b: props.b.httpVersion },
    { label: "status", a: String(props.a.status ?? ""), b: String(props.b.status ?? "") },
  ];
  return (
    <table class="w-full text-xs mono">
      <tbody>
        <For each={rows}>{(r) => {
          const diff = r.a !== r.b;
          return (
            <tr class={`border-b border-ink-100/40 dark:border-ink-400/20 ${diff ? "bg-amber-400/5" : ""}`}>
              <td class="px-4 py-1.5 align-top w-[15%] text-toucan-400">{r.label}</td>
              <td class={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-rose-400" : "opacity-70"}`}>{r.a}</td>
              <td class={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-emerald-400" : "opacity-70"}`}>{r.b}</td>
            </tr>
          );
        }}</For>
      </tbody>
    </table>
  );
}

function HeaderDiffTable(props: { rows: HeaderDiffRow[] }) {
  if (props.rows.length === 0) {
    return <div class="px-4 py-3 text-xs opacity-50 mono">{t("ins.noHeaders")}</div>;
  }
  return (
    <table class="w-full text-xs mono">
      <tbody>
        <For each={props.rows}>{(r) => {
          const bg =
            r.status === "same" ? "" :
            r.status === "changed" ? "bg-amber-400/5" :
            r.status === "onlyA" ? "bg-rose-500/5" : "bg-emerald-500/5";
          const aTone =
            r.status === "same" ? "opacity-60" :
            r.status === "onlyA" ? "text-rose-400" :
            r.status === "onlyB" ? "opacity-30" : "text-rose-400";
          const bTone =
            r.status === "same" ? "opacity-60" :
            r.status === "onlyB" ? "text-emerald-400" :
            r.status === "onlyA" ? "opacity-30" : "text-emerald-400";
          return (
            <tr class={`border-b border-ink-100/40 dark:border-ink-400/20 ${bg}`}>
              <td class="px-4 py-1.5 align-top w-[15%] text-toucan-400 [overflow-wrap:anywhere]">{r.key}</td>
              <td class={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] whitespace-pre-wrap ${aTone}`}>{r.a ?? "—"}</td>
              <td class={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] whitespace-pre-wrap ${bTone}`}>{r.b ?? "—"}</td>
            </tr>
          );
        }}</For>
      </tbody>
    </table>
  );
}

function BodyDiff(props: { a: string | null; b: string | null; contentType: string | null }) {
  const parts = createMemo(() => diffBody(props.a, props.b, props.contentType));
  const empty = () => (props.a == null || props.a === "") && (props.b == null || props.b === "");
  return (
    <Show when={!empty()} fallback={<div class="px-4 py-3 text-xs opacity-50 mono">(empty)</div>}>
      <pre class="mono text-[11px] leading-relaxed px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
        <For each={parts()}>{(p) => {
          const cls = p.added
            ? "bg-emerald-500/15 text-emerald-300"
            : p.removed
              ? "bg-rose-500/15 text-rose-300"
              : "opacity-60";
          const prefix = p.added ? "+ " : p.removed ? "- " : "  ";
          const lines = p.value.split("\n");
          // Drop the trailing empty string from a final "\n" so we don't render a blank line per chunk
          if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
          return (
            <For each={lines}>{(line) => (
              <div class={cls}>{prefix}{line || " "}</div>
            )}</For>
          );
        }}</For>
      </pre>
    </Show>
  );
}
