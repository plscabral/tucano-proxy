import { useEffect, useMemo, useRef, useState } from "react";
import { X, ArrowLeftRight, GitCompareArrows, StickyNote, ChevronRight, Check } from "lucide-react";
import type { Flow } from "@/lib/types";
import { diffHeaders, diffBody, type HeaderDiffRow } from "@/lib/diff";
import { t } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { useFlows } from "@/stores/flows";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function CompareView({ a: aProp, b: bProp, onClose }: { a: Flow; b: Flow; onClose: () => void }) {
  const [a, setA] = useState<Flow>(aProp);
  const [b, setB] = useState<Flow>(bProp);
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const swap = () => { setA(b); setB(a); };
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);

  const reqHeaders = useMemo(() => diffHeaders(a.reqHeaders, b.reqHeaders), [a, b]);
  const resHeaders = useMemo(() => diffHeaders(a.resHeaders, b.resHeaders), [a, b]);
  const metaRows = useMemo(() => metaOf(a, b), [a, b]);

  const metaDiffs = metaRows.filter((r) => r.a !== r.b).length;
  const reqHeaderDiffs = reqHeaders.filter((r) => r.status !== "same").length;
  const resHeaderDiffs = resHeaders.filter((r) => r.status !== "same").length;
  const reqBodyDiffs = useMemo(() => countBodyDiffs(a.reqBody, b.reqBody, a.reqContentType ?? b.reqContentType), [a, b]);
  const resBodyDiffs = useMemo(() => countBodyDiffs(a.resBody, b.resBody, a.resContentType ?? b.resContentType), [a, b]);
  const totalDiffs = metaDiffs + reqHeaderDiffs + resHeaderDiffs + reqBodyDiffs + resBodyDiffs;

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex flex-col"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      tabIndex={-1}
    >
      <div
        style={{ marginTop: IS_MAC ? 40 : 20 }}
        className="mx-5 mb-5 flex-1 min-h-0 rounded-2xl bg-white dark:bg-[#0a0a0c] ring-1 ring-border shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="relative shrink-0 border-b border-border overflow-hidden">
          <div className="absolute inset-0 tcn-grid opacity-40 pointer-events-none" />
          <div className="absolute inset-x-0 top-0 h-16 tcn-glow-radial pointer-events-none" />
          <div className="relative flex items-center gap-3 px-5 py-3">
            <div className="w-9 h-9 rounded-xl tcn-accent-soft ring-1 ring-inset ring-toucan-400/25 text-toucan-500 dark:text-toucan-300 grid place-items-center shrink-0">
              <GitCompareArrows size={16} />
            </div>
            <div className="leading-none">
              <div className="font-bold tracking-tight text-[15px] flex items-center gap-2">
                {t("compare.title") || "Compare"}
                <span className={`text-[10px] mono px-1.5 py-0.5 rounded-md ring-1 ring-inset ${totalDiffs > 0 ? "bg-amber-400/10 text-amber-500 dark:text-amber-300 ring-amber-400/25" : "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 ring-emerald-500/25"}`}>
                  {totalDiffs > 0 ? `${totalDiffs} diff${totalDiffs > 1 ? "s" : ""}` : "identical"}
                </span>
              </div>
              <div className="text-[11px] opacity-55 mt-1 flex items-center gap-2 mono">
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-rose-400" /> A</span>
                <ArrowLeftRight size={10} className="opacity-50" />
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> B</span>
              </div>
            </div>
            <div className="flex-1" />
            {/* Only-differences toggle */}
            <button
              onClick={() => setOnlyDiffs((v) => !v)}
              className={`h-9 px-3.5 rounded-xl text-xs font-medium flex items-center gap-1.5 ring-1 ring-inset transition
                ${onlyDiffs ? "tcn-accent-soft text-toucan-500 dark:text-toucan-300 ring-toucan-400/30" : "ring-border hover:ring-toucan-400/50"}`}
            >
              <span className={`h-3.5 w-3.5 rounded grid place-items-center ${onlyDiffs ? "tcn-accent text-white" : "ring-1 ring-inset ring-border"}`}>
                {onlyDiffs && <Check size={10} strokeWidth={3} />}
              </span>
              {t("compare.onlyDiffs") || "Only differences"}
            </button>
            <button onClick={swap} title={t("compare.swap") || "Swap A ↔ B"} className="h-9 px-3.5 rounded-xl text-xs flex items-center gap-1.5 ring-1 ring-inset ring-border hover:ring-toucan-400/50 hover:text-toucan-500 dark:hover:text-toucan-300 transition">
              <ArrowLeftRight size={13} /> {t("compare.swap") || "Swap"}
            </button>
            <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-xl opacity-60 hover:opacity-100 hover:bg-muted transition">
              <X size={15} />
            </button>
          </div>
        </div>

        {/* A / B summaries */}
        <div className="grid grid-cols-2 gap-px bg-border shrink-0">
          <FlowSummary label="A" tone="rose" flow={a} onNote={(note) => setA({ ...a, note })} />
          <FlowSummary label="B" tone="emerald" flow={b} onNote={(note) => setB({ ...b, note })} />
        </div>

        {/* Diff body */}
        <div className="flex-1 min-h-0 overflow-auto scroll-thin bg-muted/30">
          <Section title={t("compare.meta") || "Request line / metadata"} count={metaDiffs} forceOpen={metaDiffs > 0}>
            <MetaTable rows={metaRows} onlyDiffs={onlyDiffs} />
          </Section>
          <Section title={t("compare.reqHeaders") || "Request headers"} count={reqHeaderDiffs} forceOpen={reqHeaderDiffs > 0}>
            <HeaderDiffTable rows={reqHeaders} onlyDiffs={onlyDiffs} />
          </Section>
          <Section title={t("compare.reqBody") || "Request body"} count={reqBodyDiffs} forceOpen={reqBodyDiffs > 0}>
            <BodyDiff a={a.reqBody} b={b.reqBody} contentType={a.reqContentType ?? b.reqContentType} onlyDiffs={onlyDiffs} />
          </Section>
          <Section title={t("compare.resHeaders") || "Response headers"} count={resHeaderDiffs} forceOpen={resHeaderDiffs > 0}>
            <HeaderDiffTable rows={resHeaders} onlyDiffs={onlyDiffs} />
          </Section>
          <Section title={t("compare.resBody") || "Response body"} count={resBodyDiffs} forceOpen={resBodyDiffs > 0}>
            <BodyDiff a={a.resBody} b={b.resBody} contentType={a.resContentType ?? b.resContentType} onlyDiffs={onlyDiffs} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function metaOf(a: Flow, b: Flow) {
  return [
    { label: "method", a: a.method, b: b.method },
    { label: "scheme", a: a.scheme, b: b.scheme },
    { label: "host", a: a.host, b: b.host },
    { label: "port", a: String(a.port), b: String(b.port) },
    { label: "path", a: a.path, b: b.path },
    { label: "httpVersion", a: a.httpVersion, b: b.httpVersion },
    { label: "status", a: String(a.status ?? ""), b: String(b.status ?? "") },
  ];
}
function countBodyDiffs(a: string | null, b: string | null, ct: string | null) {
  try { return diffBody(a, b, ct).filter((p) => p.added || p.removed).length; } catch { return 0; }
}

function FlowSummary({ label, tone, flow, onNote }: { label: string; tone: "rose" | "emerald"; flow: Flow; onNote: (note: string | null) => void }) {
  const url = () => {
    const def = (flow.scheme === "https" && flow.port === 443) || (flow.scheme === "http" && flow.port === 80);
    return `${flow.scheme}://${flow.host}${def ? "" : ":" + flow.port}${flow.path}`;
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flow.note ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  const accent = tone === "rose" ? "text-rose-400" : "text-emerald-400";
  const badge = tone === "rose" ? "bg-rose-500/12 text-rose-400 ring-rose-500/25" : "bg-emerald-500/12 text-emerald-400 ring-emerald-500/25";

  return (
    <div className="relative bg-white dark:bg-[#0a0a0c] px-4 py-3">
      <div className={`absolute left-0 inset-y-0 w-[3px] ${tone === "rose" ? "bg-rose-400/70" : "bg-emerald-400/70"}`} />
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`h-5 px-2 grid place-items-center rounded-md text-[10px] font-bold mono ring-1 ring-inset ${badge}`}>{label}</span>
        <span className="text-[10px] uppercase tracking-wider opacity-45 mono">#{flow.index}</span>
      </div>
      <div className="mono text-xs flex items-center gap-2">
        <span className={`font-semibold ${accent}`}>{flow.method}</span>
        <span className="opacity-70">{flow.status ?? "…"}</span>
        <span className="truncate opacity-90" title={url()}>{url()}</span>
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
            className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-muted ring-1 ring-inset ring-border focus:ring-toucan-400/60 outline-none resize-y"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="flex-1 text-left px-2.5 py-1.5 rounded-lg hover:bg-muted transition min-w-0">
            {flow.note ? <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{flow.note}</span> : <span className="opacity-45 italic">{t("note.placeholder")}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ title, count = 0, forceOpen, children }: { title: string; count?: number; forceOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(forceOpen ?? false);
  // Reflect the latest diff state (e.g. after a swap) unless the user toggled.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(!!forceOpen); }, [forceOpen]);
  return (
    <div className="border-b border-border">
      <button
        onClick={() => { touched.current = true; setOpen((o) => !o); }}
        className="group w-full px-4 py-2.5 text-left text-[11px] uppercase tracking-[0.12em] font-semibold opacity-70 hover:opacity-100 hover:bg-toucan-400/5 transition flex items-center gap-2"
      >
        <ChevronRight size={13} className={`opacity-50 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="flex-1">{title}</span>
        {count > 0 ? (
          <span className="text-[10px] mono px-1.5 py-0.5 rounded-md bg-amber-400/12 text-amber-500 dark:text-amber-300 ring-1 ring-inset ring-amber-400/25 normal-case tracking-normal">{count}</span>
        ) : (
          <Check size={13} className="text-emerald-500/70" />
        )}
      </button>
      {open && <div className="bg-white dark:bg-[#0a0a0c]">{children}</div>}
    </div>
  );
}

function MetaTable({ rows, onlyDiffs }: { rows: { label: string; a: string; b: string }[]; onlyDiffs: boolean }) {
  const shown = onlyDiffs ? rows.filter((r) => r.a !== r.b) : rows;
  if (shown.length === 0) return <Identical />;
  return (
    <table className="w-full text-xs mono">
      <tbody>
        {shown.map((r) => {
          const diff = r.a !== r.b;
          return (
            <tr key={r.label} className={`border-b border-border/60 ${diff ? "bg-amber-400/[0.06]" : ""}`}>
              <td className="px-4 py-1.5 align-top w-[15%] text-toucan-500 dark:text-toucan-300">{r.label}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-rose-400" : "opacity-65"}`}>{r.a}</td>
              <td className={`px-3 py-1.5 align-top w-[42.5%] [overflow-wrap:anywhere] ${diff ? "text-emerald-400" : "opacity-65"}`}>{r.b}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatusMark({ status }: { status: HeaderDiffRow["status"] }) {
  if (status === "same") return <span className="opacity-30">=</span>;
  if (status === "changed") return <span className="text-amber-500 dark:text-amber-300">~</span>;
  if (status === "onlyA") return <span className="text-rose-400">−</span>;
  return <span className="text-emerald-400">+</span>;
}

function HeaderDiffTable({ rows, onlyDiffs }: { rows: HeaderDiffRow[]; onlyDiffs: boolean }) {
  const shown = onlyDiffs ? rows.filter((r) => r.status !== "same") : rows;
  if (rows.length === 0) return <div className="px-4 py-3 text-xs opacity-50 mono">{t("ins.noHeaders")}</div>;
  if (shown.length === 0) return <Identical />;
  return (
    <table className="w-full text-xs mono">
      <tbody>
        {shown.map((r, i) => {
          const bg = r.status === "same" ? "" : r.status === "changed" ? "bg-amber-400/[0.06]" : r.status === "onlyA" ? "bg-rose-500/[0.06]" : "bg-emerald-500/[0.06]";
          const aTone = r.status === "same" ? "opacity-60" : r.status === "onlyA" ? "text-rose-400" : r.status === "onlyB" ? "opacity-30" : "text-rose-400";
          const bTone = r.status === "same" ? "opacity-60" : r.status === "onlyB" ? "text-emerald-400" : r.status === "onlyA" ? "opacity-30" : "text-emerald-400";
          return (
            <tr key={i} className={`border-b border-border/60 ${bg}`}>
              <td className="px-2 py-1.5 align-top w-6 text-center font-bold"><StatusMark status={r.status} /></td>
              <td className="px-2 py-1.5 align-top w-[15%] text-toucan-500 dark:text-toucan-300 [overflow-wrap:anywhere]">{r.key}</td>
              <td className={`px-3 py-1.5 align-top w-[42%] [overflow-wrap:anywhere] whitespace-pre-wrap ${aTone}`}>{r.a ?? "—"}</td>
              <td className={`px-3 py-1.5 align-top w-[42%] [overflow-wrap:anywhere] whitespace-pre-wrap ${bTone}`}>{r.b ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BodyDiff({ a, b, contentType, onlyDiffs }: { a: string | null; b: string | null; contentType: string | null; onlyDiffs: boolean }) {
  const parts = useMemo(() => diffBody(a, b, contentType), [a, b, contentType]);
  const empty = (a == null || a === "") && (b == null || b === "");
  if (empty) return <div className="px-4 py-3 text-xs opacity-50 mono">(empty)</div>;
  const hasChange = parts.some((p) => p.added || p.removed);
  if (!hasChange) return <Identical />;
  return (
    <pre className="mono text-[11px] leading-relaxed px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
      {parts.map((p, pi) => {
        if (onlyDiffs && !p.added && !p.removed) {
          // Collapse long unchanged runs to a thin context marker.
          const n = p.value.split("\n").filter(Boolean).length;
          if (n > 2) return <div key={pi} className="opacity-25 italic select-none">  ⋯ {n} unchanged lines</div>;
        }
        const cls = p.added ? "bg-emerald-500/15 text-emerald-300" : p.removed ? "bg-rose-500/15 text-rose-300" : "opacity-55";
        const prefix = p.added ? "+ " : p.removed ? "- " : "  ";
        const lines = p.value.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        return lines.map((line, li) => <div key={`${pi}-${li}`} className={cls}>{prefix}{line || " "}</div>);
      })}
    </pre>
  );
}

function Identical() {
  return (
    <div className="px-4 py-3 text-xs opacity-50 mono flex items-center gap-2">
      <Check size={13} className="text-emerald-500/70" /> identical
    </div>
  );
}
