import { createMemo, createSignal, Show, For } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { Flow } from "../lib/types";
import { flowsStore } from "../stores/flows";
import { marksStore, MARK_COLORS, colorOf } from "../stores/marks";
import { ipc } from "../lib/ipc";
import { undoStore } from "../stores/undo";
import { columnsStore, type ColId } from "../stores/columns";
import { sortStore } from "../stores/sort";
import { noteStore } from "../stores/note";
import { findAllStore } from "../stores/findAll";
import { t } from "../lib/i18n";
import {
  ArrowUp, ArrowDown, AppWindow, Radio, WifiOff, ChevronRight, StickyNote, GripVertical,
  FileText, Film, Music, Database, Plug, FileType, Network, Braces, Type, FileCode2,
  GitCompareArrows, Crosshair,
} from "lucide-solid";
import {
  SiJavascript, SiCss, SiHtml5, SiGraphql,
} from "solid-icons/si";
import {
  FaSolidFileImage,
  FaSolidCode, FaSolidFileImport, FaSolidPencil, FaSolidPenToSquare, FaSolidTrash,
  FaSolidEye, FaSolidGear, FaSolidWrench,
} from "solid-icons/fa";
import { EXPORT_FORMATS } from "../lib/exporters";
import NoteDialog from "./NoteDialog";

function statusColor(s: number | null) {
  if (s == null) return "text-ink-300";
  if (s >= 500) return "text-red-400";
  if (s >= 400) return "text-amber-400";
  if (s >= 300) return "text-cyan-300/80";
  if (s >= 200) return "text-emerald-400";
  return "text-ink-200";
}
function methodColor(m: string) {
  switch (m.toUpperCase()) {
    case "GET":     return "text-emerald-400";
    case "POST":    return "text-cyan-300/80";
    case "PUT":     return "text-amber-400";
    case "PATCH":   return "text-fuchsia-400";
    case "DELETE":  return "text-red-400";
    case "HEAD":    return "text-violet-400";
    case "OPTIONS": return "text-teal-400";
    default:        return "text-ink-200";
  }
}
// Maps a flow to a Fiddler-style icon. Primary distinction is the HTTP method
// (GET ≠ POST regardless of response). Status colors the icon. Special cases:
// WebSocket and CONNECT keep their own glyphs since they aren't really "requests".
// Memoize the rendered icon JSX per flow id + a cheap signature of the inputs
// that affect it. typeIcon runs for every visible row on every list refresh,
// and each call does ~12 regex tests + brand-icon allocations. With 50+ visible
// rows during active capture this dominates row render time.
const _iconCache = new Map<string, { sig: string; node: any }>();
function typeIcon(f: Flow) {
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
function _typeIconImpl(f: Flow, ct: string, isWs: boolean, status: number | null) {
  const path = f.path.toLowerCase();
  const sz = 14;

  if (f.method === "CONNECT")                                        return <Network size={sz} class="text-slate-300" />;
  if (isWs)                                                          return <Plug size={sz} class="text-fuchsia-300" />;

  // Brand-style icons for known formats take priority over the method glyph
  // (CSS, JS, HTML, JSON, etc. are immediately recognizable). For anything
  // generic, fall through to the method-based icon below.
  const brand = (color: string) => ({ size: sz + "px", color });
  if (ct.includes("graphql") || path.includes("/graphql"))           return <SiGraphql {...brand("#E10098")} />;
  if (ct.includes("json") || /\.json(\?|$)/.test(path))              return <Braces size={sz} class="text-amber-300" />;
  if (ct.includes("xml") || /\.xml(\?|$)/.test(path))                return <FileCode2 size={sz} class="text-orange-400" />;
  if (ct.includes("javascript") || ct.includes("ecmascript") || /\.m?js(\?|$)/.test(path))
                                                                     return <SiJavascript {...brand("#F7DF1E")} />;
  if (ct.includes("css") || /\.css(\?|$)/.test(path))                return <SiCss {...brand("#1572B6")} />;
  if (ct.includes("html") || ct.includes("text/html"))               return <SiHtml5 {...brand("#E34F26")} />;
  if (ct.includes("pdf") || /\.pdf(\?|$)/.test(path))                return <FileType size={sz} class="text-red-300" />;
  if (ct.includes("form-urlencoded") || ct.includes("multipart/form")) return <FileText size={sz} class="text-teal-300" />;
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|$)/.test(path))
                                                                     return <FaSolidFileImage {...brand("#A78BFA")} />;
  if (ct.startsWith("video/") || /\.(mp4|webm|mov|mkv)(\?|$)/.test(path))
                                                                     return <Film size={sz} class="text-violet-300" />;
  if (ct.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)(\?|$)/.test(path))
                                                                     return <Music size={sz} class="text-violet-300" />;
  if (ct.startsWith("font/") || ct.includes("font") || /\.(woff2?|ttf|otf|eot)(\?|$)/.test(path))
                                                                     return <Type size={sz} class="text-cyan-300" />;
  if (ct.includes("octet-stream") || ct.includes("zip") || ct.includes("tar") || ct.includes("gzip"))
                                                                     return <Database size={sz} class="text-slate-300" />;
  if (ct.startsWith("text/"))                                        return <FileText size={sz} class="text-slate-200" />;

  // Method-based fallback — Fiddler-style. Color tracks the response status so
  // a 4xx GET still looks different from a 4xx POST while signalling the error.
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
    case "GET":     return <FaSolidCode         {...brand(tone)} />;
    case "POST":    return <FaSolidFileImport   {...brand(tone)} />;
    case "PUT":     return <FaSolidPenToSquare  {...brand(tone)} />;
    case "PATCH":   return <FaSolidPencil       {...brand(tone)} />;
    case "DELETE":  return <FaSolidTrash        {...brand(tone)} />;
    case "HEAD":    return <FaSolidEye          {...brand(tone)} />;
    case "OPTIONS": return <FaSolidGear         {...brand(tone)} />;
    default:        return <FaSolidWrench       {...brand(tone)} />;
  }
}

function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function renderCell(f: Flow, id: ColId) {
  switch (id) {
    case "index":    return (
      <div class="flex items-center gap-1.5 truncate pl-3 pr-2">
        <span class="shrink-0">{typeIcon(f)}</span>
        <span class="opacity-50 truncate">{f.index}</span>
      </div>
    );
    case "method":   return <div class={`truncate pl-3 pr-2 font-semibold ${methodColor(f.method)}`}>{f.method}</div>;
    case "status":   return <div class={`truncate pl-3 pr-2 font-semibold ${statusColor(f.status)}`}>{f.status ?? "—"}</div>;
    case "host":     return <div class="truncate pl-3 pr-2">{f.host}</div>;
    case "path":     return <div class="truncate pl-3 pr-2 opacity-80">{f.path}</div>;
    case "size":     return <div class="truncate pl-3 pr-2 opacity-70">{fmtSize(f.resSize || f.reqSize)}</div>;
    case "duration": return <div class="truncate pl-3 pr-2 opacity-70">{f.durationMs != null ? `${f.durationMs}ms` : "…"}</div>;
    case "scheme":   return <div class="truncate pl-3 pr-2 opacity-70 uppercase">{f.scheme}</div>;
    case "mime":     return <div class="truncate pl-3 pr-2 opacity-70">{f.resContentType ?? f.reqContentType ?? "—"}</div>;
    case "client":   return (
      <div class={`flex items-center gap-1.5 truncate pl-3 pr-2 ${f.clientApp ? "" : "opacity-40"}`}>
        {f.clientIcon
          ? <img src={f.clientIcon} alt="" class="h-4 w-4 rounded-sm shrink-0" />
          : <span class="h-4 w-4 rounded-sm bg-ink-100 dark:bg-ink-400/30 shrink-0 grid place-items-center text-ink-400 dark:text-ink-200">
              <AppWindow size={10} />
            </span>}
        <span class="truncate">{f.clientApp ?? "—"}</span>
      </div>
    );
    case "note":     return (
      <div class={`flex items-center gap-1.5 truncate pl-3 pr-2 ${f.note ? "text-toucan-400" : "opacity-30"}`} title={f.note ?? ""}>
        <Show when={f.note} fallback={<span class="opacity-50">—</span>}>
          <StickyNote size={11} class="shrink-0" />
          <span class="truncate">{f.note}</span>
        </Show>
      </div>
    );
  }
}

type Ctx = { id: string; x: number; y: number };

export default function FlowList(props: { flows: Flow[]; onCompare?: () => void; onOpen?: (id: string) => void }) {
  let parentRef!: HTMLDivElement;
  const rows = createMemo(() => props.flows);
  const [ctx, setCtx] = createSignal<Ctx | null>(null);
  const [dragId, setDragId] = createSignal<ColId | null>(null);
  const [dragOver, setDragOver] = createSignal<ColId | null>(null);

  const visibleCols = () => columnsStore.visible();
  // Reserve a fixed-width gutter at the very start of the grid for the
  // selection / find-all indicators so they live in their own column
  // instead of pushing the data columns around when toggled.
  const INDICATOR_W = 48;
  const gridTemplate = () => `${INDICATOR_W}px ${visibleCols().map((c) => `${c.width}px`).join(" ")}`;
  const totalWidth = () => visibleCols().reduce((s, c) => s + c.width, 0) + INDICATOR_W + 24;

  const virt = createVirtualizer({
    get count() { return rows().length; },
    getScrollElement: () => parentRef,
    estimateSize: () => 32,
    overscan: 30,
  });

  // Stable visible entries: a click handler must keep firing on the row the
  // user actually pressed, even while the captures torrent re-renders the
  // surrounding list. `getVirtualItems()` returns brand-new objects every call,
  // so we recycle the SAME wrapper reference whenever the underlying flow id
  // and y-position are unchanged. Solid's `<For>` keys by element reference,
  // so DOM nodes (and their listeners) survive across updates — fixing the
  // "click on row N, selection lands on N+1" race during heavy capture.
  type VisibleEntry = { id: string; f: Flow; start: number; size: number };
  // LRU-ish cache (Map preserves insertion order; we re-insert on hit so the
  // oldest unused entries fall off the front). Keeping recently-seen entries
  // around means scrolling back over visited rows recycles the SAME wrapper
  // refs → Solid's <For> reuses DOM instead of mounting fresh nodes — which
  // was the source of the white flash on fast scroll.
  const ENTRY_CACHE_MAX = 500;
  const _entryCache = new Map<string, VisibleEntry>();
  const visibleEntries = createMemo<VisibleEntry[]>(() => {
    const items = virt.getVirtualItems();
    const arr = rows();
    const out: VisibleEntry[] = [];
    for (const vi of items) {
      const f = arr[vi.index];
      if (!f) continue;
      const prev = _entryCache.get(f.id);
      if (prev && prev.f === f && prev.start === vi.start && prev.size === vi.size) {
        // Touch (re-insert) so it's marked as recently used.
        _entryCache.delete(f.id);
        _entryCache.set(f.id, prev);
        out.push(prev);
      } else {
        const entry: VisibleEntry = { id: f.id, f, start: vi.start, size: vi.size };
        if (prev) _entryCache.delete(f.id);
        _entryCache.set(f.id, entry);
        out.push(entry);
      }
    }
    // Evict oldest until we're under the cap.
    while (_entryCache.size > ENTRY_CACHE_MAX) {
      const oldestKey = _entryCache.keys().next().value;
      if (oldestKey === undefined) break;
      _entryCache.delete(oldestKey);
    }
    return out;
  });

  // Manual double-click detection: SolidJS re-renders on selectSingle() which
  // can destroy the DOM node before the native dblclick fires on it. Track the
  // last click id + timestamp ourselves so the second click always opens the
  // inspector even after a re-render.
  let lastClickId = "";
  let lastClickTime = 0;
  const DBL_CLICK_MS = 350;

  const onRowClick = (e: MouseEvent, id: string) => {
    if (e.shiftKey) { flowsStore.selectRange(id, rows()); return; }
    if (e.metaKey || e.ctrlKey) { flowsStore.toggle(id); return; }

    const now = Date.now();
    if (id === lastClickId && now - lastClickTime < DBL_CLICK_MS) {
      // Second click within threshold → open inspector
      lastClickId = "";
      lastClickTime = 0;
      flowsStore.selectSingle(id);
      props.onOpen?.(id);
      if (findAllStore.active() && findAllStore.isMatch(id)) {
        const q = findAllStore.query();
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("tucano:findAll", { detail: { query: q } }));
        });
      }
    } else {
      lastClickId = id;
      lastClickTime = now;
      flowsStore.selectSingle(id);
    }
  };

  const onRowDblClick = (_e: MouseEvent, _id: string) => { /* handled in onRowClick */ };
  const onContext = (e: MouseEvent, id: string) => {
    e.preventDefault();
    if (!flowsStore.isSelected(id)) flowsStore.selectSingle(id);
    setCtx({ id, x: e.clientX, y: e.clientY });
  };
  const closeCtx = () => setCtx(null);

  const deleteSelected = async () => {
    const ids = flowsStore.selectedIds();
    if (ids.size === 0) return;
    const snapshot = flowsStore.flows().filter((f) => ids.has(f.id));
    await ipc.deleteFlows(Array.from(ids));
    flowsStore.removeMany(ids);
    undoStore.push(snapshot);
    closeCtx();
  };
  const markSelected = (color: string) => {
    flowsStore.selectedIds().forEach((id) => marksStore.set(id, color));
    closeCtx();
  };
  const noteFlow = () => {
    const id = noteStore.openId();
    return id ? flowsStore.flows().find((f) => f.id === id) ?? null : null;
  };
  const editNote = () => {
    const c = ctx();
    if (!c) return;
    noteStore.open(c.id);
    closeCtx();
  };
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    closeCtx();
  };
  const ctxFlow = () => {
    const c = ctx();
    return c ? rows().find((f) => f.id === c.id) ?? null : null;
  };


  const fullUrlOf = (f: Flow) => {
    const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
    return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}${f.path}`;
  };
  const baseUrlOf = (f: Flow) => {
    const def = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
    return `${f.scheme}://${f.host}${def ? "" : ":" + f.port}`;
  };
  const saveNote = async (value: string | null) => {
    const flow = noteFlow();
    noteStore.close();
    if (!flow) return;
    try {
      await ipc.updateFlowNote(flow.id, value);
      flowsStore.upsert({ ...flow, note: value });
    } catch (e) { console.error(e); }
  };
  const [exportOpen, setExportOpen] = createSignal(false);
  const copySelectedAs = async (build: (f: Flow) => string) => {
    const c = ctx();
    if (!c) return;
    const ids = flowsStore.selectedIds();
    const targets = (ids.size > 0 ? rows().filter((f) => ids.has(f.id)) : rows().filter((f) => f.id === c.id));
    if (targets.length === 0) return;
    try {
      const text = targets.map(build).join("\n\n");
      await navigator.clipboard.writeText(text);
    } catch {}
    setExportOpen(false);
    closeCtx();
  };

  // Column resize
  const startResize = (e: MouseEvent, id: ColId, startW: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX;
    const move = (ev: MouseEvent) => columnsStore.setWidth(id, startW + (ev.clientX - x0));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Auto-fit column to its widest visible content (Excel-style dbl-click).
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
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
      case "mime":     return f.resContentType ?? f.reqContentType ?? "—";
      case "client":   return f.clientApp ?? "—";
      case "note":     return f.note ?? "";
    }
  };
  // Cells with a leading icon/avatar that also takes horizontal space.
  const ICON_PAD: Partial<Record<ColId, number>> = {
    index: 22,   // type icon ~14px + gap 6 + slack
    client: 22,  // app icon 16 + gap 6
    note: 18,    // sticky-note icon 11 + gap 6
  };
  const autoFitColumn = (id: ColId) => {
    if (!measureCtx) return;
    // text-xs (12px) + the JetBrains-mono fallback used by .mono class.
    measureCtx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    let max = 0;
    for (const f of rows()) {
      const w = measureCtx.measureText(cellText(f, id)).width;
      if (w > max) max = w;
    }
    // Floor: header label width (so the title never gets cut off).
    const headerLabel = t(`col.${id}`);
    measureCtx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    const headerW = measureCtx.measureText(headerLabel.toUpperCase()).width * 1.12; // tracking
    // Padding: pl-3 (12) + pr-2 (8) + sort-arrow/grip space (~24) + icon overhead.
    const padding = 12 + 8 + 24 + (ICON_PAD[id] ?? 0);
    const target = Math.ceil(Math.max(max, headerW) + padding);
    columnsStore.setWidth(id, Math.min(target, 900));
  };

  // Manual column drag (mouse-based — bypasses HTML5 DnD which is flaky in WebView)
  const startHeaderDrag = (e: MouseEvent, id: ColId) => {
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
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const target = dragOver();
      setDragId(null);
      setDragOver(null);
      if (started && target && target !== id) {
        const targetIdx = columnsStore.cols().findIndex((x) => x.id === target);
        columnsStore.move(id, targetIdx);
      } else if (!started) {
        // pure click — toggle sort
        sortStore.toggle(id);
      }
      if (suppressClick) {
        const stop = (e2: MouseEvent) => { e2.stopPropagation(); e2.preventDefault(); };
        window.addEventListener("click", stop, { capture: true, once: true });
      }
      void ev;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div class="h-full flex flex-col relative" onClick={closeCtx}>
      {/* Single scroll container for both axes. Vertical scrollbar stays
          pinned to the FlowList's visible right edge (instead of sitting
          beyond the wide content when columns overflow horizontally), so
          the scrollbar stays usable when the inspector is open. */}
      <div ref={parentRef} class="flex-1 min-h-0 overflow-auto scroll-thin" style={{ "scrollbar-gutter": "stable" }}>
      <div class="flex flex-col" style={{ "min-width": `${totalWidth()}px` }}>
      {/* Header — sticky so it stays visible while the rows scroll. */}
      <div
        class="sticky top-0 z-10 grid h-9 items-stretch text-[10px] uppercase tracking-[0.12em] bg-ink-50/60 dark:bg-ink-600 border-b border-ink-100 dark:border-ink-400/30 mono opacity-90 shrink-0 backdrop-blur"
        style={{ "grid-template-columns": gridTemplate() }}
      >
        {/* Indicator gutter — empty header to keep columns aligned. */}
        <div class="h-full" />
        <For each={visibleCols()}>{(c, i) => {
          const sortState = sortStore.state;
          const isSorted = () => sortState().by === c.id;
          const isLast = () => i() === visibleCols().length - 1;
          return (
            <div
              data-col-header={c.id}
              onMouseDown={(e) => startHeaderDrag(e, c.id)}
              class={`group relative h-full flex items-center gap-1.5 pl-3 pr-5 select-none cursor-grab active:cursor-grabbing
                ${!isLast() ? "border-r border-ink-100 dark:border-ink-400/30" : ""}
                ${dragOver() === c.id && dragId() !== c.id ? "bg-toucan-400/15 ring-2 ring-toucan-400/60" : ""}
                ${dragId() === c.id ? "opacity-50" : ""}
                ${isSorted() ? "text-toucan-400" : "hover:text-toucan-400 hover:bg-ink-100/40 dark:hover:bg-ink-400/15"}`}
              title={`${t("col.dragHint")} · ${t(`col.${c.id}`)}`}
            >
              <GripVertical size={11} class="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-50 transition pointer-events-none" />
              <span class="truncate">{t(`col.${c.id}`)}</span>
              {isSorted() && (sortState().dir === "asc"
                ? <ArrowUp size={11} />
                : <ArrowDown size={11} />)}
              <span
                onMouseDown={(e) => startResize(e, c.id, c.width)}
                onClick={(e) => e.stopPropagation()}
                onDblClick={(e) => { e.stopPropagation(); autoFitColumn(c.id); }}
                title={t("col.autoFitHint")}
                class="absolute right-0 top-0 h-full w-3 cursor-col-resize flex items-center justify-center group/r"
              >
                <span class="block w-px h-4 bg-ink-200 dark:bg-ink-300 opacity-0 group-hover/r:opacity-100 group-hover/r:bg-toucan-400 transition" />
              </span>
            </div>
          );
        }}</For>
      </div>

      {/* Rows — virtualizer scrolls on the outer parentRef now. */}
      <div class="relative">
        <div
          class="tcn-row-skeleton"
          style={{ height: `${virt.getTotalSize()}px`, position: "relative", width: "100%" }}
        >
          <For each={visibleEntries()}>{(entry) => {
            const f = entry.f;
            // IMPORTANT: <For> only runs this child once per recycled entry —
            // store reads MUST be functions called from JSX so Solid tracks
            // them as fine-grained reactivity. If they were `const sel = ...`
            // here, Cmd+A / Shift-click would update the Set but the visible
            // rows would never re-paint.
            const sel = () => flowsStore.isSelected(f.id);
            const markColor = () => colorOf(marksStore.marks()[f.id]);
            const findHit = () => findAllStore.active() && findAllStore.isMatch(f.id);
            const fullUrl = `${f.scheme}://${f.host}${
              (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80)
                ? ""
                : `:${f.port}`
            }${f.path}`;
            return (
              <div
                onClick={(e) => onRowClick(e, f.id)}
                onDblClick={(e) => onRowDblClick(e, f.id)}
                onContextMenu={(e) => onContext(e, f.id)}
                title={fullUrl}
                style={{
                  position: "absolute", top: 0, left: 0, right: 0,
                  height: `${entry.size}px`, transform: `translateY(${entry.start}px)`,
                  background: sel()
                    ? undefined
                    : (markColor() ? `${markColor()}1f` : undefined),
                  "border-left": markColor() ? `3px solid ${markColor()}` : "3px solid transparent",
                  "box-shadow": sel()
                    ? "inset 3px 0 0 0 rgb(99 102 241 / 0.95)"
                    : undefined,
                  "grid-template-columns": gridTemplate(),
                }}
                class={`grid items-center text-xs mono cursor-pointer select-none pr-3
                  ${sel()
                    ? "bg-gradient-to-r from-indigo-500/10 via-indigo-500/5 to-transparent dark:from-indigo-400/20 dark:via-indigo-400/10 font-medium"
                    : findHit()
                      ? "bg-yellow-300/10 hover:bg-yellow-300/20 dark:bg-yellow-200/5 dark:hover:bg-yellow-200/15"
                      : "hover:bg-ink-50 dark:hover:bg-ink-400/20"}
                  border-b border-ink-100/70 dark:border-ink-400/20`}
              >
                <div class="h-full grid grid-cols-[6px_13px_11px] items-center justify-center gap-2 pl-2.5 pr-1">
                  <span class="grid place-items-center">
                    <Show
                      when={findHit()}
                      fallback={
                        <span class="h-1.5 w-1.5 rounded-full bg-ink-200/40 dark:bg-ink-200/50" />
                      }
                    >
                      <span class="relative grid place-items-center h-1.5 w-1.5" title={t("findAll.matchBadge")}>
                        <span class="absolute inset-0 rounded-full bg-yellow-400/60 animate-ping" />
                        <span class="relative h-1.5 w-1.5 rounded-full bg-yellow-400" />
                      </span>
                    </Show>
                  </span>
                  <span class="grid place-items-center">
                    <Show when={sel()}>
                      <span class="text-indigo-500 dark:text-indigo-300" title={t("list.selectedRow")}>
                        <Crosshair size={13} stroke-width={2.25} />
                      </span>
                    </Show>
                  </span>
                  <span class="grid place-items-center"></span>
                </div>
                <For each={visibleCols()}>{(c) => renderCell(f, c.id)}</For>
              </div>
            );
          }}</For>
        </div>
      </div>
      </div>
      </div>
      {rows().length === 0 && (
          <div class="absolute inset-0 top-9 flex items-center justify-center px-6 text-center pointer-events-none select-none">
            <div class="flex flex-col items-center justify-center gap-5 max-w-sm">
              <Show
                when={flowsStore.status().running}
                fallback={
                  <div class="relative w-24 h-24 flex items-center justify-center">
                    <span class="absolute w-16 h-16 rounded-full bg-ink-200/20 dark:bg-ink-300/15" />
                    <WifiOff size={36} class="relative text-ink-300 dark:text-ink-200/70" stroke-width={1.75} />
                  </div>
                }
              >
                <div class="relative w-24 h-24 flex items-center justify-center">
                  <span class="absolute w-20 h-20 rounded-full bg-toucan-400/10 animate-ping" />
                  <span class="absolute w-16 h-16 rounded-full bg-toucan-400/15" />
                  <Radio size={36} class="relative text-toucan-400" stroke-width={1.75} />
                </div>
              </Show>
              <div class="flex flex-col items-center gap-1">
                <div class={`text-base font-semibold ${flowsStore.status().running ? "text-ink-500 dark:text-ink-50" : "text-ink-400 dark:text-ink-200/80"}`}>
                  {flowsStore.status().running ? t("list.emptyTitle") : t("list.emptyTitleOff")}
                </div>
                <div class="text-xs opacity-60 leading-relaxed">
                  {flowsStore.status().running
                    ? t("list.empty", { port: flowsStore.status().port })
                    : t("list.emptyOff")}
                </div>
              </div>
            </div>
          </div>
        )}

      <Show when={ctx()}>
        {(c) => (
          <div
            class="fixed z-40 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-2xl py-1.5 min-w-[200px] text-xs"
            style={{ left: `${c().x}px`, top: `${c().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">
              {t("list.selected", { n: flowsStore.selectedIds().size })}
            </div>
            <Show when={props.onOpen}>
              <button
                onClick={() => { props.onOpen?.(c().id); closeCtx(); }}
                class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400"
              >
                <span>Open</span><span class="opacity-50 mono text-[10px]">↵</span>
              </button>
            </Show>
            <button onClick={deleteSelected}
              class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-red-500/10 hover:text-red-500">
              <span>{t("list.delete")}</span><span class="opacity-50 mono">⌫</span>
            </button>
            <button onClick={editNote}
              class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400">
              <span>{rows().find((f) => f.id === c().id)?.note ? t("list.editNote") : t("list.addNote")}</span>
              <StickyNote size={11} class="opacity-60" />
            </button>
            <Show when={flowsStore.selectedIds().size === 2 && props.onCompare}>
              <button
                onClick={() => { props.onCompare?.(); closeCtx(); }}
                class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10 hover:text-toucan-400"
              >
                <span>{t("tb.compare")}</span>
                <GitCompareArrows size={11} class="opacity-60" />
              </button>
            </Show>
            <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
            <button
              onClick={() => { const f = ctxFlow(); if (f) copyText(fullUrlOf(f)); }}
              class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
              title={ctxFlow() ? fullUrlOf(ctxFlow()!) : ""}
            >{t("list.copyUrl")}</button>
            <button
              onClick={() => { const f = ctxFlow(); if (f) copyText(baseUrlOf(f)); }}
              class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
              title={ctxFlow() ? baseUrlOf(ctxFlow()!) : ""}
            >{t("list.copyBaseUrl")}</button>
            <button
              onClick={() => { const f = ctxFlow(); if (f) copyText(f.path); }}
              class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 truncate"
            >{t("list.copyPath")}</button>
            <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
            <div
              class="relative"
              onMouseEnter={() => setExportOpen(true)}
              onMouseLeave={() => setExportOpen(false)}
            >
              <button class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-toucan-400/10">
                <span>{t("list.copyAs")}</span>
                <ChevronRight size={12} class="opacity-50" />
              </button>
              <Show when={exportOpen()}>
                <div
                  class="absolute left-full top-0 -ml-px bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-2xl py-1.5 min-w-[200px] text-xs"
                >
                  <For each={EXPORT_FORMATS}>{(fmt) => (
                    <button
                      onClick={() => copySelectedAs(fmt.build)}
                      class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400"
                    >{fmt.label}</button>
                  )}</For>
                </div>
              </Show>
            </div>
            <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
            <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">{t("list.markWithColor")}</div>
            <For each={MARK_COLORS}>{(col) => (
              <button
                onClick={() => markSelected(col.id)}
                class="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-toucan-400/10"
              >
                <span class="block h-3 w-3 rounded-full border border-current/20" style={{ background: col.color }} />
                {t(`mark.${col.id}`)}
              </button>
            )}</For>
          </div>
        )}
      </Show>

      <NoteDialog
        open={noteFlow() !== null}
        initialValue={noteFlow()?.note ?? ""}
        onSave={saveNote}
        onClose={() => noteStore.close()}
      />
    </div>
  );
}
