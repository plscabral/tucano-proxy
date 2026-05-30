import { useEffect, useMemo, useRef, useState } from "react";
import { X, ArrowLeftRight, GitCompareArrows, StickyNote } from "lucide-react";
import type { Flow } from "@/lib/types";
import { diffHeaders, diffBody, type HeaderDiffRow } from "@/lib/diff";
import { t } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { useFlows } from "@/stores/flows";

export default function CompareView({ a: aProp, b: bProp, onClose }: { a: Flow; b: Flow; onClose: () => void }) {
  const [a, setA] = useState<Flow>(aProp);
  const [b, setB] = useState<Flow>(bProp);
  const swap = () => { setA(b); setB(a); };
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      tabIndex={-1}
    >
      <div className="m-4 flex-1 min-h-0 rounded-2xl bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
          <GitCompareArrows size={14} className="text-toucan-400" />
          <span className="text-sm font-semibold">{t("compare.title") || "Compare"}</span>
          <div className="flex-1" />
          <button onClick={swap} title={t("compare.swap") || "Swap A ↔ B"} className="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
            <ArrowLeftRight size={13} /> {t("compare.swap") || "Swap"}
          </button>
          <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20">
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-px bg-ink-100 dark:bg-ink-400/30 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
          <FlowSummary label="A" tone="text-rose-400" flow={a} onNote={(note) => setA({ ...a, note })} />
          <FlowSummary label="B" tone="text-emerald-400" flow={b} onNote={(note) => setB({ ...b, note })} />
        </div>

        <div className="flex-1 min-h-0 overflow-auto scroll-thin bg-ink-50/40 dark:bg-ink-600">
          <Section title={t("compare.meta") || "Request line / metadata"} initialOpen><MetaTable a={a} b={b} /></Section>
          <Section title={t("compare.reqHeaders") || "Request headers"} initialOpen><HeaderDiffTable rows={diffHeaders(a.reqHeaders, b.reqHeaders)} /></Section>
          <Section title={t("compare.reqBody") || "Request body"} initialOpen><BodyDiff a={a.reqBody} b={b.reqBody} contentType={a.reqContentType ?? b.reqContentType} /></Section>
          <Section title={t("compare.resHeaders") || "Response headers"}><HeaderDiffTable rows={diffHeaders(a.resHeaders, b.resHeaders)} /></Section>
          <Section title={t("compare.resBody") || "Response body"}><BodyDiff a={a.resBody} b={b.resBody} contentType={a.resContentType ?? b.resContentType} /></Section>
        </div>
      </div>
    </div>
  );
}

function FlowSummary({ label, tone, flow, onNote }: { label: string; tone: string; flow: Flow; onNote: (note: string | null) => void }) {
  const url = () => {
    const def = (flow.scheme === "https" && flow.port === 443) || (flow.scheme === "http" && flow.port === 80);
    return `${flow.scheme}://${flow.host}${def ? "" : ":" + flow.port}${flow.path}`;
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flow.note ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Resync draft when the underlying flow swaps (A/B), unless mid-edit.
  useEffect(() => {
    if (!editing) setDraft(flow.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id]);
  useEffect(() => { if (editing) taRef.current?.focus(); }, [editing]);

  const commit = async () => {
    const v = draft.trim();
    const next = v.length > 0 ? v : null;
    setEditing(false);
    if (next === (flow.note ?? null)) return;
    try {
      await ipc.updateFlowNote(flow.id, next);
      useFlows.getState().upsert({ ...flow, note: next });
      onNote(next);
    } catch (e) { console.error(e); }
  };
  const cancel = () => { setDraft(flow.note ?? ""); setEditing(false); };

  return (
    <div className="bg-white dark:bg-ink-500 px-4 py-2.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider mb-1">
        <span className={`font-semibold ${tone}`}>{label}</span>
        <span className="opacity-50">#{flow.index}</span>
      </div>
      <div className="mono text-xs flex items-center gap-2">
        <span className="font-semibold">{flow.method}</span>
        <span className="opacity-70">{flow.status ?? "…"}</span>
        <span className="truncate" title={url()}>{url()}</span>
      </div>
      <div className="mt-2 flex items-start gap-2 text-xs">
        <StickyNote size={12} className="text-toucan-400 mt-1 shrink-0" />
        {editing ? (
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); cancel(); }
              else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
            }}
            rows={2}
            placeholder={t("note.placeholder")}
            className="flex-1 px-2 py-1 text-xs rounded-lg bg-ink-50 dark:bg-ink-600 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="flex-1 text-left px-2 py-1 rounded-lg hover:bg-ink-50 dark:hover:bg-ink-400/20 transition min-w-0">
            {flow.note ? <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{flow.note}</span> : <span className="opacity-50 italic">{t("note.placeholder")}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ title, initialOpen, children }: { title: string; initialOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initialOpen ?? false);
  return (
    <div className="border-b border-ink-100 dark:border-ink-400/30">
      <button onClick={() => setOpen(!open)} className="w-full px-4 py-2 text-left text-xs uppercase tracking-wider font-semibold opacity-70 hover:opacity-100 hover:bg-toucan-400/5 transition flex items-center gap-2">
        <span className="opacity-60">{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="bg-white dark:bg-ink-500">{children}</div>}
    </div>
  );
}

function MetaTable({ a, b }: { a: Flow; b: Flow }) {
  const rows = [
    { label: "method", a: a.method, b: b.method },
    { label: "scheme", a: a.scheme, b: b.scheme },
    { label: "host", a: a.host, b: b.host },
    { label: "port", a: String(a.port), b: String(b.port) },
    { label: "path", a: a.path, b: b.path },
    { label: "httpVersion", a: a.httpVersion, b: b.httpVersion },
    { label: "status", a: String(a.status ?? ""), b: String(b.status ?? "") },
  ];
  return (
    <table className="w-full text-xs mono">
      <tbody>
        {rows.map((r) => {
          const diff = r.a !== r.b;
          return (
            <tr key={r.label} className={`border-b border-ink-100/40 dark:border-ink-400/20 ${diff ? "bg-amber-400/5" : ""}`}>
              <td className="px-4 py-1.5 align-top w-[15%] text-toucan-400">{r.label}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-rose-400" : "opacity-70"}`}>{r.a}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-emerald-400" : "opacity-70"}`}>{r.b}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HeaderDiffTable({ rows }: { rows: HeaderDiffRow[] }) {
  if (rows.length === 0) {
    return <div className="px-4 py-3 text-xs opacity-50 mono">{t("ins.noHeaders")}</div>;
  }
  return (
    <table className="w-full text-xs mono">
      <tbody>
        {rows.map((r, i) => {
          const bg = r.status === "same" ? "" : r.status === "changed" ? "bg-amber-400/5" : r.status === "onlyA" ? "bg-rose-500/5" : "bg-emerald-500/5";
          const aTone = r.status === "same" ? "opacity-60" : r.status === "onlyA" ? "text-rose-400" : r.status === "onlyB" ? "opacity-30" : "text-rose-400";
          const bTone = r.status === "same" ? "opacity-60" : r.status === "onlyB" ? "text-emerald-400" : r.status === "onlyA" ? "opacity-30" : "text-emerald-400";
          return (
            <tr key={i} className={`border-b border-ink-100/40 dark:border-ink-400/20 ${bg}`}>
              <td className="px-4 py-1.5 align-top w-[15%] text-toucan-400 [overflow-wrap:anywhere]">{r.key}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] whitespace-pre-wrap ${aTone}`}>{r.a ?? "—"}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] whitespace-pre-wrap ${bTone}`}>{r.b ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BodyDiff({ a, b, contentType }: { a: string | null; b: string | null; contentType: string | null }) {
  const parts = useMemo(() => diffBody(a, b, contentType), [a, b, contentType]);
  const empty = (a == null || a === "") && (b == null || b === "");
  if (empty) return <div className="px-4 py-3 text-xs opacity-50 mono">(empty)</div>;
  return (
    <pre className="mono text-[11px] leading-relaxed px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
      {parts.map((p, pi) => {
        const cls = p.added ? "bg-emerald-500/15 text-emerald-300" : p.removed ? "bg-rose-500/15 text-rose-300" : "opacity-60";
        const prefix = p.added ? "+ " : p.removed ? "- " : "  ";
        const lines = p.value.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        return lines.map((line, li) => <div key={`${pi}-${li}`} className={cls}>{prefix}{line || " "}</div>);
      })}
    </pre>
  );
}
