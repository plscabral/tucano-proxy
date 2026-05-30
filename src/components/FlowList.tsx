import * as React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Flow } from "@/lib/types";
import { useFlows } from "@/stores/flows";
import { useMarks, MARK_COLORS, colorOf } from "@/stores/marks";
import { ipc } from "@/lib/ipc";
import { useUndo } from "@/stores/undo";
import { useColumns, type ColId } from "@/stores/columns";
import { useSort } from "@/stores/sort";
import { useNote } from "@/stores/note";
import { useFindAll } from "@/stores/findAll";
import { useIgnored } from "@/stores/ignored";
import { t } from "@/lib/i18n";
import {
  ArrowUp, ArrowDown, AppWindow, Radio, WifiOff, ChevronRight, StickyNote, GripVertical,
  FileText, Film, Music, Database, Plug, FileType, Network, Braces, Type, FileCode2,
  GitCompareArrows, Crosshair, EyeOff,
} from "lucide-react";
import { SiJavascript, SiCss, SiHtml5, SiGraphql } from "react-icons/si";
import {
  FaFileImage, FaCode, FaFileImport, FaPencil, FaPenToSquare, FaTrash, FaEye, FaGear, FaWrench,
} from "react-icons/fa6";
import { EXPORT_FORMATS } from "@/lib/exporters";
import NoteDialog from "./NoteDialog";
import { Display, Accent } from "./Display";
import proxyMark from "@/assets/tucano-proxy-mark.svg";

function statusChipClass(s: number | null) {
  if (s == null) return "bg-ink-100/70 dark:bg-white/[0.04] text-ink-300 backdrop-blur-sm";
  if (s >= 500) return "bg-red-50 text-red-700 dark:bg-red-500/[0.08] dark:text-red-300 dark:ring-1 dark:ring-inset dark:ring-red-400/20 backdrop-blur-sm";
  if (s >= 400) return "bg-amber-50 text-amber-800 dark:bg-amber-500/[0.08] dark:text-amber-300 dark:ring-1 dark:ring-inset dark:ring-amber-400/20 backdrop-blur-sm";
  if (s >= 300) return "bg-cyan-50 text-cyan-800 dark:bg-cyan-500/[0.08] dark:text-cyan-300 dark:ring-1 dark:ring-inset dark:ring-cyan-400/20 backdrop-blur-sm";
  if (s >= 200) return "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/[0.08] dark:text-emerald-300 dark:ring-1 dark:ring-inset dark:ring-emerald-400/20 backdrop-blur-sm";
  return "bg-ink-100/70 dark:bg-white/[0.04] text-ink-200 backdrop-blur-sm";
}
function methodChipClass(m: string) {
  const base = "backdrop-blur-sm";
  switch (m.toUpperCase()) {
    case "GET":     return `${base} bg-emerald-50 text-emerald-800 dark:bg-emerald-500/[0.08] dark:text-emerald-300 dark:ring-1 dark:ring-inset dark:ring-emerald-400/20`;
    case "POST":    return `${base} bg-cyan-50 text-cyan-800 dark:bg-cyan-500/[0.08] dark:text-cyan-300 dark:ring-1 dark:ring-inset dark:ring-cyan-400/20`;
    case "PUT":     return `${base} bg-amber-50 text-amber-800 dark:bg-amber-500/[0.08] dark:text-amber-300 dark:ring-1 dark:ring-inset dark:ring-amber-400/20`;
    case "PATCH":   return `${base} bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-500/[0.08] dark:text-fuchsia-300 dark:ring-1 dark:ring-inset dark:ring-fuchsia-400/20`;
    case "DELETE":  return `${base} bg-red-50 text-red-700 dark:bg-red-500/[0.08] dark:text-red-300 dark:ring-1 dark:ring-inset dark:ring-red-400/20`;
    case "HEAD":    return `${base} bg-violet-50 text-violet-800 dark:bg-violet-500/[0.08] dark:text-violet-300 dark:ring-1 dark:ring-inset dark:ring-violet-400/20`;
    case "OPTIONS": return `${base} bg-teal-50 text-teal-800 dark:bg-teal-500/[0.08] dark:text-teal-300 dark:ring-1 dark:ring-inset dark:ring-teal-400/20`;
    case "CONNECT": return `${base} bg-indigo-50 text-indigo-800 dark:bg-indigo-500/[0.08] dark:text-indigo-300 dark:ring-1 dark:ring-inset dark:ring-indigo-400/20`;
    default:        return `${base} bg-ink-100/70 dark:bg-white/[0.04] text-ink-300`;
  }
}

// Splits a Content-Type header into mime + charset parts.
function splitCt(f: Flow): { mime: string; charset: string } {
  const raw = f.resContentType ?? f.reqContentType ?? "";
  if (!raw) return { mime: "—", charset: "—" };
  const [mimePart, ...params] = raw.split(";").map((s) => s.trim());
  const charsetParam = params.find((p) => /^charset=/i.test(p));
  const charset = charsetParam ? charsetParam.split("=")[1].trim().replace(/^"|"$/g, "") : "—";
  return { mime: mimePart || "—", charset };
}

// Maps a flow to a Fiddler-style icon. Memoized per flow id + a cheap signature
// of the inputs that affect it — typeIcon runs for every visible row on every
// list refresh, and each call does ~12 regex tests + brand-icon allocations.
const _iconCache = new Map<string, { sig: string; node: React.ReactNode }>();
function typeIcon(f: Flow): React.ReactNode {
  const ct = (f.resContentType || f.reqContentType || "").toLowerCase();
  const isWs = f.reqHeaders.some(([k, v]) => k.toLowerCase() === "upgrade" && v.toLowerCase() === "websocket");
  const status = f.status;
  const sig = `${f.method}|${status ?? ""}|${ct}|${isWs ? 1 : 0}|${f.path}`;
  const cached = _iconCache.get(f.id);
  if (cached && cached.sig === sig) return cached.node;
  const node = _typeIconImpl(f, ct, isWs, status);
  _iconCache.set(f.id, { sig, node });
  return node;
}
function _typeIconImpl(f: Flow, ct: string, isWs: boolean, status: number | null): React.ReactNode {
  const path = f.path.toLowerCase();
  const sz = 14;

  if (f.method === "CONNECT")                                        return <Network size={sz} className="text-slate-300" />;
  if (isWs)                                                          return <Plug size={sz} className="text-fuchsia-300" />;

  const brand = (color: string) => ({ size: sz, color });
  if (ct.includes("graphql") || path.includes("/graphql"))           return <SiGraphql {...brand("#E10098")} />;
  if (ct.includes("json") || /\.json(\?|$)/.test(path))              return <Braces size={sz} className="text-amber-300" />;
  if (ct.includes("xml") || /\.xml(\?|$)/.test(path))                return <FileCode2 size={sz} className="text-orange-400" />;
  if (ct.includes("javascript") || ct.includes("ecmascript") || /\.m?js(\?|$)/.test(path))
                                                                     return <SiJavascript {...brand("#F7DF1E")} />;
  if (ct.includes("css") || /\.css(\?|$)/.test(path))                return <SiCss {...brand("#1572B6")} />;
  if (ct.includes("html") || ct.includes("text/html"))               return <SiHtml5 {...brand("#E34F26")} />;
  if (ct.includes("pdf") || /\.pdf(\?|$)/.test(path))                return <FileType size={sz} className="text-red-300" />;
  if (ct.includes("form-urlencoded") || ct.includes("multipart/form")) return <FileText size={sz} className="text-teal-300" />;
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|$)/.test(path))
                                                                     return <FaFileImage {...brand("#A78BFA")} />;
  if (ct.startsWith("video/") || /\.(mp4|webm|mov|mkv)(\?|$)/.test(path))
                                                                     return <Film size={sz} className="text-violet-300" />;
  if (ct.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)(\?|$)/.test(path))
                                                                     return <Music size={sz} className="text-violet-300" />;
  if (ct.startsWith("font/") || ct.includes("font") || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(path))
                                                                     return <Type size={sz} className="text-cyan-300" />;
  if (ct.includes("octet-stream") || ct.includes("zip") || ct.includes("tar") || ct.includes("gzip"))
                                                                     return <Database size={sz} className="text-slate-300" />;
  if (ct.startsWith("text/"))                                        return <FileText size={sz} className="text-slate-200" />;

  const errorTone =
    status != null && status >= 500 ? "#FCA5A5" :
    status != null && status >= 400 ? "#FCD34D" :
    null;
  const methodTone = (() => {
    switch (f.method.toUpperCase()) {
      case "GET":     return "#34D399";
      case "POST":    return "#67E8F9";
      case "PUT":     return "#FBBF24";
      case "PATCH":   return "#E879F9";
      case "DELETE":  return "#F87171";
      case "HEAD":    return "#A78BFA";
      case "OPTIONS": return "#2DD4BF";
      default:        return "#CBD5E1";
    }
  })();
  const tone = errorTone ?? methodTone;
  switch (f.method.toUpperCase()) {
    case "GET":     return <FaCode         {...brand(tone)} />;
    case "POST":    return <FaFileImport   {...brand(tone)} />;
    case "PUT":     return <FaPenToSquare  {...brand(tone)} />;
    case "PATCH":   return <FaPencil       {...brand(tone)} />;
    case "DELETE":  return <FaTrash        {...brand(tone)} />;
    case "HEAD":    return <FaEye          {...brand(tone)} />;
    case "OPTIONS": return <FaGear         {...brand(tone)} />;
    default:        return <FaWrench       {...brand(tone)} />;
  }
}

function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function renderCell(f: Flow, id: ColId): React.ReactNode {
  switch (id) {
    case "index":    return (
      <div className="flex items-center gap-1.5 truncate pl-3 pr-2">
        <span className="shrink-0">{typeIcon(f)}</span>
        <span className="opacity-50 truncate">{f.index}</span>
      </div>
    );
    case "method":   return (
      <div className="pl-2 pr-2 flex items-center">
        <span className={`px-1.5 py-[1px] rounded text-[10px] font-bold mono tracking-[0.06em] ${methodChipClass(f.method)}`}>{f.method}</span>
      </div>
    );
    case "status":   return (
      <div className="pl-2 pr-2 flex items-center">
        <span className={`px-1.5 py-[1px] rounded text-[10px] font-bold mono tracking-[0.06em] ${statusChipClass(f.status)}`}>{f.status ?? "—"}</span>
      </div>
    );
    case "host":     return <div className="truncate pl-3 pr-2">{f.host}</div>;
    case "path":     return <div className="truncate pl-3 pr-2 opacity-80">{f.path}</div>;
    case "size":     return <div className="truncate pl-3 pr-2 opacity-70">{fmtSize(f.resSize || f.reqSize)}</div>;
    case "duration": return <div className="truncate pl-3 pr-2 opacity-70">{f.durationMs != null ? `${f.durationMs}ms` : "…"}</div>;
    case "scheme":   return <div className="truncate pl-3 pr-2 opacity-70 uppercase">{f.scheme}</div>;
    case "mime":     return <div className="truncate pl-3 pr-2 opacity-70">{splitCt(f).mime}</div>;
    case "charset":  return <div className="truncate pl-3 pr-2 opacity-70">{splitCt(f).charset}</div>;
    case "client":   return (
      <div className={`flex items-center gap-1.5 truncate pl-3 pr-2 ${f.clientApp ? "" : "opacity-40"}`}>
        {f.clientIcon
          ? <img src={f.clientIcon} alt="" className="h-4 w-4 rounded-sm shrink-0" />
          : <span className="h-4 w-4 rounded-sm bg-ink-100 dark:bg-ink-400/30 shrink-0 grid place-items-center text-ink-400 dark:text-ink-200">
              <AppWindow size={10} />
            </span>}
        <span className="truncate">{f.clientApp ?? "—"}</span>
      </div>
    );
    case "note":     return (
      <div className={`flex items-center gap-1.5 truncate pl-3 pr-2 ${f.note ? "text-toucan-400" : "opacity-30"}`} title={f.note ?? ""}>
        {f.note ? (
          <>
            <StickyNote size={11} className="shrink-0" />
            <span className="truncate">{f.note}</span>
          </>
        ) : <span className="opacity-50">—</span>}
      </div>
    );
  }
}

const def443or80 = (f: Flow) =>
  (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
const fullUrlOf = (f: Flow) => `${f.scheme}://${f.host}${def443or80(f) ? "" : ":" + f.port}${f.path}`;
const baseUrlOf = (f: Flow) => `${f.scheme}://${f.host}${def443or80(f) ? "" : ":" + f.port}`;

type Ctx = { id: string; x: number; y: number };

// --- Row: memoized so only rows whose own selection / mark / find-hit slice
// changes re-render, recreating the fine-grained reactivity of the Solid app.
const Row = React.memo(function Row({
  f, start, size, visibleCols, gridTemplate,
  onRowClick, onContext,
}: {
  f: Flow;
  start: number;
  size: number;
  visibleCols: { id: ColId; width: number }[];
  gridTemplate: string;
  onRowClick: (e: React.MouseEvent, id: string) => void;
  onContext: (e: React.MouseEvent, id: string) => void;
}) {
  const sel = useFlows((s) => s.selectedIds.has(f.id));
  const markColor = colorOf(useMarks((s) => s.marks[f.id]));
  const findHit = useFindAll((s) => s.open && s.query.length > 0 && s.matches.has(f.id));
  const fullUrl = fullUrlOf(f);

  return (
    <div
      onClick={(e) => onRowClick(e, f.id)}
      onContextMenu={(e) => onContext(e, f.id)}
      title={fullUrl}
      style={{
        position: "absolute", top: 0, left: 0, right: 0,
        height: `${size}px`, transform: `translateY(${start}px)`,
        background: markColor ? `${markColor}${sel ? "40" : "1f"}` : undefined,
        boxShadow: markColor
          ? `inset 2px 0 0 0 ${markColor}`
          : sel ? "inset 2px 0 0 0 rgb(106 87 224 / 1)" : undefined,
        gridTemplateColumns: gridTemplate,
      }}
      className={`grid items-center text-xs mono cursor-pointer select-none pr-3
        ${sel
          ? (markColor
              ? "font-medium"
              : "bg-gradient-to-r from-toucan-400/25 via-toucan-400/10 to-toucan-400/[0.03] dark:from-toucan-400/25 dark:via-toucan-400/10 dark:to-toucan-400/[0.02] font-medium")
          : findHit
            ? "bg-yellow-300/10 hover:bg-yellow-300/20 dark:bg-yellow-200/5 dark:hover:bg-yellow-200/15"
            : "hover:bg-ink-100/40 dark:hover:bg-white/[0.03]"}
        border-b border-ink-100/40 dark:border-white/[0.04]`}
    >
      <div className="h-full grid grid-cols-[6px_13px_11px] items-center justify-center gap-2 pl-4 pr-1">
        <span className="grid place-items-center">
          {findHit ? (
            <span className="relative grid place-items-center h-1.5 w-1.5" title={t("findAll.matchBadge")}>
              <span className="absolute inset-0 rounded-full bg-yellow-400/60 animate-ping" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-yellow-400" />
            </span>
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-ink-200/40 dark:bg-ink-200/50" />
          )}
        </span>
        <span className="grid place-items-center">
          {sel && (
            <span className="text-toucan-500 dark:text-toucan-400" title={t("list.selectedRow")}>
              <Crosshair size={13} strokeWidth={2.25} />
            </span>
          )}
        </span>
        <span className="grid place-items-center" />
      </div>
      {visibleCols.map((c) => (
        <React.Fragment key={c.id}>{renderCell(f, c.id)}</React.Fragment>
      ))}
    </div>
  );
});

// Canvas for autoFit text measurement (Excel-style dbl-click on resize handle).
const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");

export default function FlowList({ flows, onCompare, onOpen }: { flows: Flow[]; onCompare?: () => void; onOpen?: (id: string) => void }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = flows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [dragId, setDragId] = useState<ColId | null>(null);
  const [dragOver, setDragOver] = useState<ColId | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const colList = useColumns((s) => s.list);
  const visibleCols = useMemo(() => colList.filter((c) => c.visible), [colList]);
  const sortBy = useSort((s) => s.by);
  const sortDir = useSort((s) => s.dir);
  const running = useFlows((s) => s.status.running);
  const port = useFlows((s) => s.status.port);
  const noteOpenId = useNote((s) => s.openId);
  const selectedCount = useFlows((s) => s.selectedIds.size);

  const INDICATOR_W = 48;
  const gridTemplate = useMemo(
    () => `${INDICATOR_W}px ${visibleCols.map((c) => `${c.width}px`).join(" ")}`,
    [visibleCols],
  );
  const totalWidth = useMemo(
    () => visibleCols.reduce((s, c) => s + c.width, 0) + INDICATOR_W + 24,
    [visibleCols],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 30,
  });

  // Manual double-click detection — a re-render can destroy the DOM node before
  // a native dblclick fires, so track the last click id + timestamp ourselves.
  const lastClick = useRef({ id: "", time: 0 });
  const DBL_CLICK_MS = 350;

  const onRowClick = useCallback((e: React.MouseEvent, id: string) => {
    const flowsStore = useFlows.getState();
    if (e.shiftKey) { flowsStore.selectRange(id, rowsRef.current); return; }
    if (e.metaKey || e.ctrlKey) { flowsStore.toggle(id); return; }
    const now = Date.now();
    if (id === lastClick.current.id && now - lastClick.current.time < DBL_CLICK_MS) {
      lastClick.current = { id: "", time: 0 };
      flowsStore.selectSingle(id);
      onOpen?.(id);
      const fa = useFindAll.getState();
      if (fa.active() && fa.isMatch(id)) {
        const q = fa.query;
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("tucano:findAll", { detail: { query: q } }));
        });
      }
    } else {
      lastClick.current = { id, time: now };
      flowsStore.selectSingle(id);
    }
  }, [onOpen]);

  const onContext = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const flowsStore = useFlows.getState();
    if (!flowsStore.isSelected(id)) flowsStore.selectSingle(id);
    setCtx({ id, x: e.clientX, y: e.clientY });
  }, []);
  const closeCtx = () => setCtx(null);

  const ctxFlow = (): Flow | null => (ctx ? rows.find((f) => f.id === ctx.id) ?? null : null);

  const deleteSelected = async () => {
    const ids = useFlows.getState().selectedIds;
    if (ids.size === 0) return;
    const snapshot = useFlows.getState().flows.filter((f) => ids.has(f.id));
    await ipc.deleteFlows(Array.from(ids));
    useFlows.getState().removeMany(ids);
    useUndo.getState().push(snapshot);
    closeCtx();
  };
  const markSelected = (color: string) => {
    useFlows.getState().selectedIds.forEach((id) => useMarks.getState().set(id, color));
    closeCtx();
  };
  const editNote = () => {
    if (!ctx) return;
    useNote.getState().open(ctx.id);
    closeCtx();
  };
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    closeCtx();
  };
  const copySelectedAs = async (build: (f: Flow) => string) => {
    if (!ctx) return;
    const ids = useFlows.getState().selectedIds;
    const targets = ids.size > 0 ? rows.filter((f) => ids.has(f.id)) : rows.filter((f) => f.id === ctx.id);
    if (targets.length === 0) return;
    try { await navigator.clipboard.writeText(targets.map(build).join("\n\n")); } catch {}
    setExportOpen(false);
    closeCtx();
  };

  // Note dialog plumbing
  const noteFlow = noteOpenId ? rows.find((f) => f.id === noteOpenId) ?? null : null;
  const saveNote = async (value: string | null) => {
    const flow = noteFlow;
    useNote.getState().close();
    if (!flow) return;
    try {
      await ipc.updateFlowNote(flow.id, value);
      useFlows.getState().upsert({ ...flow, note: value });
    } catch (e) { console.error(e); }
  };

  // Column resize
  const startResize = (e: React.MouseEvent, id: ColId, startW: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX;
    const move = (ev: MouseEvent) => useColumns.getState().setWidth(id, startW + (ev.clientX - x0));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const cellText = (f: Flow, id: ColId): string => {
    switch (id) {
      case "index":    return String(f.index);
      case "method":   return f.method;
      case "status":   return f.status != null ? String(f.status) : "—";
      case "host":     return f.host;
      case "path":     return f.path;
      case "size":     return fmtSize(f.resSize || f.reqSize);
      case "duration": return f.durationMs != null ? `${f.durationMs}ms` : "…";
      case "scheme":   return f.scheme.toUpperCase();
      case "mime":     return splitCt(f).mime;
      case "charset":  return splitCt(f).charset;
      case "client":   return f.clientApp ?? "—";
      case "note":     return f.note ?? "";
    }
  };
  const ICON_PAD: Partial<Record<ColId, number>> = { index: 22, client: 22, note: 18 };
  const autoFitColumn = (id: ColId) => {
    if (!measureCtx) return;
    measureCtx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    let max = 0;
    for (const f of rowsRef.current) {
      const w = measureCtx.measureText(cellText(f, id)).width;
      if (w > max) max = w;
    }
    const headerLabel = t(`col.${id}`);
    measureCtx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    const headerW = measureCtx.measureText(headerLabel.toUpperCase()).width * 1.12;
    const padding = 12 + 8 + 24 + (ICON_PAD[id] ?? 0);
    const target = Math.ceil(Math.max(max, headerW) + padding);
    useColumns.getState().setWidth(id, Math.min(target, 900));
  };

  // dragOver is read inside the mouseup closure — mirror it to a ref so the
  // once-bound listener sees the latest value.
  const dragOverRef = useRef(dragOver);
  dragOverRef.current = dragOver;

  // Manual column drag (mouse-based — bypasses HTML5 DnD which is flaky in WebView)
  const startHeaderDrag = (e: React.MouseEvent, id: ColId) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    let started = false;
    let suppressClick = false;
    const move = (ev: MouseEvent) => {
      if (!started && Math.abs(ev.clientX - x0) > 5) {
        started = true;
        suppressClick = true;
        setDragId(id);
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      if (!started) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const headerEl = el?.closest("[data-col-header]") as HTMLElement | null;
      const overId = headerEl?.dataset.colHeader as ColId | undefined;
      setDragOver(overId && overId !== id ? overId : null);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const target = dragOverRef.current;
      setDragId(null);
      setDragOver(null);
      if (started && target && target !== id) {
        const targetIdx = useColumns.getState().list.findIndex((x) => x.id === target);
        useColumns.getState().move(id, targetIdx);
      } else if (!started) {
        useSort.getState().toggle(id);
      }
      if (suppressClick) {
        const stop = (e2: MouseEvent) => { e2.stopPropagation(); e2.preventDefault(); };
        window.addEventListener("click", stop, { capture: true, once: true });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="h-full flex flex-col relative bg-white dark:bg-[#000000]" onClick={closeCtx}>
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto scroll-thin bg-white dark:bg-[#000000]" style={{ scrollbarGutter: "stable" }}>
        <div className="flex flex-col" style={{ minWidth: `${totalWidth}px` }}>
          {/* Header — sticky so it stays visible while the rows scroll. */}
          <div
            className="sticky top-0 z-10 grid h-9 items-stretch text-[10px] uppercase tracking-[0.14em] tcn-glass border-b border-ink-100/60 dark:border-white/10 mono text-ink-400 dark:text-ink-200/80 font-medium shrink-0"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className="h-full" />
            {visibleCols.map((c, i) => {
              const isSorted = sortBy === c.id;
              const isLast = i === visibleCols.length - 1;
              return (
                <div
                  key={c.id}
                  data-col-header={c.id}
                  onMouseDown={(e) => startHeaderDrag(e, c.id)}
                  className={`group relative h-full flex items-center gap-1.5 pl-3 pr-5 select-none cursor-grab active:cursor-grabbing
                    ${!isLast ? "border-r border-ink-100 dark:border-ink-400/30" : ""}
                    ${dragOver === c.id && dragId !== c.id ? "bg-toucan-400/15 ring-2 ring-toucan-400/60" : ""}
                    ${dragId === c.id ? "opacity-50" : ""}
                    ${isSorted ? "text-toucan-400" : "hover:text-toucan-400 hover:bg-ink-100/40 dark:hover:bg-ink-400/15"}`}
                  title={`${t("col.dragHint")} · ${t(`col.${c.id}`)}`}
                >
                  <GripVertical size={11} className="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-50 transition pointer-events-none" />
                  <span className="truncate">{t(`col.${c.id}`)}</span>
                  {isSorted && (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  <span
                    onMouseDown={(e) => startResize(e, c.id, c.width)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(c.id); }}
                    title={t("col.autoFitHint")}
                    className="absolute right-0 top-0 h-full w-3 cursor-col-resize flex items-center justify-center group/r"
                  >
                    <span className="block w-px h-4 bg-ink-200 dark:bg-ink-300 opacity-0 group-hover/r:opacity-100 group-hover/r:bg-toucan-400 transition" />
                  </span>
                </div>
              );
            })}
          </div>

          {/* Rows */}
          <div className="relative">
            <div
              className="tcn-row-skeleton"
              style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
            >
              {virtualItems.map((vi) => {
                const f = rows[vi.index];
                if (!f) return null;
                return (
                  <Row
                    key={f.id}
                    f={f}
                    start={vi.start}
                    size={vi.size}
                    visibleCols={visibleCols}
                    gridTemplate={gridTemplate}
                    onRowClick={onRowClick}
                    onContext={onContext}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="absolute inset-0 top-9 tcn-grid flex items-center justify-center px-6 text-center pointer-events-none select-none overflow-hidden">
          {/* Vignette so the grid fades toward the edges. */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.05)_100%)] dark:bg-[radial-gradient(ellipse_at_center,transparent_25%,rgba(0,0,0,0.6)_100%)]" />
          {/* Big soft brand glow, only while listening. */}
          {running && <div className="absolute w-[460px] h-[460px] rounded-full bg-toucan-400/10 blur-[90px]" />}

          <div className="relative flex flex-col items-center gap-6 max-w-md">
            {/* Brand mark — concentric rings + violet glow while capturing. */}
            <div className="relative grid place-items-center">
              {running && (
                <>
                  <span className="absolute w-44 h-44 rounded-full ring-1 ring-toucan-400/15" />
                  <span className="absolute w-32 h-32 rounded-full ring-1 ring-toucan-400/25" />
                  <span className="absolute w-32 h-32 rounded-full ring-1 ring-toucan-400/30 animate-ping" />
                </>
              )}
              <div
                className={`relative w-[76px] h-[76px] grid place-items-center rounded-[24px] tcn-sheen ring-1 ring-inset transition-all duration-500
                  ${running
                    ? "ring-toucan-400/30 shadow-[0_10px_44px_-10px_rgba(106,87,224,0.6)]"
                    : "ring-ink-200/60 dark:ring-white/[0.08] shadow-soft"}`}
              >
                <img
                  src={proxyMark}
                  alt=""
                  className={`w-10 h-10 object-contain transition-all duration-500 ${running ? "opacity-100" : "opacity-60 saturate-[0.4]"}`}
                />
              </div>
            </div>

            {/* Display wordmark — Manrope extrabold + Newsreader italic accent. */}
            <Display className="text-[34px] leading-none">
              Tucano <Accent className="text-[37px]">Proxy</Accent>
            </Display>

            {/* Status pill — the only status line (kept short). */}
            <div
              className={`inline-flex items-center gap-2 h-7 pl-2.5 pr-3 -mt-1 rounded-full text-xs font-semibold ring-1 ring-inset transition-colors
                ${running
                  ? "tcn-accent-soft text-toucan-500 dark:text-toucan-300 ring-toucan-400/25"
                  : "bg-ink-100/60 dark:bg-white/[0.04] text-foreground/70 dark:text-ink-200/80 ring-ink-200/50 dark:ring-white/10"}`}
            >
              <span className="relative grid place-items-center h-1.5 w-1.5">
                {running && <span className="absolute inset-0 rounded-full bg-toucan-400/70 animate-ping" />}
                <span className={`relative h-1.5 w-1.5 rounded-full ${running ? "bg-toucan-400" : "bg-ink-300/70 dark:bg-ink-200/50"}`} />
              </span>
              {running ? t("list.emptyTitle") : t("list.emptyTitleOff")}
            </div>

            {/* One subtle keyboard hint — press Space to toggle. */}
            <div className="flex items-center gap-2 text-[11px] opacity-45 mt-1">
              <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100/70 dark:bg-white/[0.06] border border-ink-200/60 dark:border-white/10 text-[10px]">Space</kbd>
              <span>{running ? t("topbar.stopTitle") : t("topbar.startTitle")}</span>
            </div>
          </div>
        </div>
      )}

      {ctx && (
        <div
          className="fixed z-40 tcn-glass rounded-2xl shadow-elev py-1.5 min-w-[200px] text-xs"
          style={{ left: `${ctx.x}px`, top: `${ctx.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">
            {t("list.selected", { n: selectedCount })}
          </div>
          {onOpen && (
            <button
              onClick={() => { onOpen?.(ctx.id); closeCtx(); }}
              className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400"
            >
              <span>Open</span><span className="opacity-50 mono text-[10px]">↵</span>
            </button>
          )}
          <button onClick={deleteSelected}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-red-500/10 hover:text-red-500">
            <span>{t("list.delete")}</span><span className="opacity-50 mono">⌫</span>
          </button>
          <button onClick={editNote}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400">
            <span>{rows.find((f) => f.id === ctx.id)?.note ? t("list.editNote") : t("list.addNote")}</span>
            <StickyNote size={11} className="opacity-60" />
          </button>
          {selectedCount === 2 && onCompare && (
            <button
              onClick={() => { onCompare?.(); closeCtx(); }}
              className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400"
            >
              <span>{t("tb.compare")}</span>
              <GitCompareArrows size={11} className="opacity-60" />
            </button>
          )}
          <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
          <button
            onClick={() => {
              const f = ctxFlow();
              if (!f || !f.clientApp) return;
              const app = f.clientApp;
              useIgnored.getState().addApp(app);
              const matchIds: string[] = [];
              for (const x of useFlows.getState().flows) if ((x.clientApp ?? "") === app) matchIds.push(x.id);
              useFlows.getState().removeMany(new Set(matchIds));
              ipc.deleteFlows(matchIds).catch(() => {});
              closeCtx();
            }}
            disabled={!ctxFlow()?.clientApp}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-red-500/10 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <span>{t("list.ignoreApp", { app: ctxFlow()?.clientApp ?? "—" })}</span>
            <EyeOff size={11} className="opacity-60" />
          </button>
          <button
            onClick={() => {
              const f = ctxFlow();
              if (!f) return;
              const host = f.host;
              useIgnored.getState().addHost(host);
              const matchIds: string[] = [];
              for (const x of useFlows.getState().flows) if (x.host === host) matchIds.push(x.id);
              useFlows.getState().removeMany(new Set(matchIds));
              ipc.deleteFlows(matchIds).catch(() => {});
              closeCtx();
            }}
            className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-red-500/10 hover:text-red-500"
          >
            <span>{t("list.ignoreHost", { host: ctxFlow()?.host ?? "—" })}</span>
            <EyeOff size={11} className="opacity-60" />
          </button>
          <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
          <button
            onClick={() => { const f = ctxFlow(); if (f) copyText(fullUrlOf(f)); }}
            className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
            title={ctxFlow() ? fullUrlOf(ctxFlow()!) : ""}
          >{t("list.copyUrl")}</button>
          <button
            onClick={() => { const f = ctxFlow(); if (f) copyText(baseUrlOf(f)); }}
            className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
            title={ctxFlow() ? baseUrlOf(ctxFlow()!) : ""}
          >{t("list.copyBaseUrl")}</button>
          <button
            onClick={() => { const f = ctxFlow(); if (f) copyText(f.path); }}
            className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
          >{t("list.copyPath")}</button>
          <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
          <div
            className="relative"
            onMouseEnter={() => setExportOpen(true)}
            onMouseLeave={() => setExportOpen(false)}
          >
            <button className="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10">
              <span>{t("list.copyAs")}</span>
              <ChevronRight size={12} className="opacity-50" />
            </button>
            {exportOpen && (
              <div className="absolute left-full top-0 -ml-px tcn-glass rounded-2xl shadow-elev py-1.5 min-w-[200px] text-xs">
                {EXPORT_FORMATS.map((fmt) => (
                  <button
                    key={fmt.label}
                    onClick={() => copySelectedAs(fmt.build)}
                    className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400"
                  >{fmt.label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">{t("list.markWithColor")}</div>
          {MARK_COLORS.map((col) => (
            <button
              key={col.id}
              onClick={() => markSelected(col.id)}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-toucan-400/10"
            >
              <span className="block h-3 w-3 rounded-full border border-current/20" style={{ background: col.color }} />
              {t(`mark.${col.id}`)}
            </button>
          ))}
        </div>
      )}

      <NoteDialog
        open={noteFlow !== null}
        initialValue={noteFlow?.note ?? ""}
        onSave={saveNote}
        onClose={() => useNote.getState().close()}
      />
    </div>
  );
}
