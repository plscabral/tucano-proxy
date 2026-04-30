import { createMemo, createSignal, Show, For } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { Flow } from "../lib/types";
import { flowsStore } from "../stores/flows";
import { marksStore, MARK_COLORS, colorOf } from "../stores/marks";
import { ipc } from "../lib/ipc";
import { columnsStore, type ColId } from "../stores/columns";
import { sortStore } from "../stores/sort";
import { t } from "../lib/i18n";
import { ArrowUp, ArrowDown, AppWindow } from "lucide-solid";

function statusColor(s: number | null) {
  if (s == null) return "text-ink-300";
  if (s >= 500) return "text-red-400";
  if (s >= 400) return "text-toucan-400";
  if (s >= 300) return "text-blue-400";
  if (s >= 200) return "text-emerald-400";
  return "text-ink-200";
}
function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function renderCell(f: Flow, id: ColId) {
  switch (id) {
    case "index":    return <div class="truncate pr-2 opacity-50">{f.index}</div>;
    case "method":   return <div class="truncate pr-2 font-semibold">{f.method}</div>;
    case "status":   return <div class={`truncate pr-2 font-semibold ${statusColor(f.status)}`}>{f.status ?? "—"}</div>;
    case "host":     return <div class="truncate pr-2">{f.host}</div>;
    case "path":     return <div class="truncate pr-2 opacity-80">{f.path}</div>;
    case "size":     return <div class="truncate pr-2 opacity-70">{fmtSize(f.resSize || f.reqSize)}</div>;
    case "duration": return <div class="truncate pr-2 opacity-70">{f.durationMs != null ? `${f.durationMs}ms` : "…"}</div>;
    case "scheme":   return <div class="truncate pr-2 opacity-70 uppercase">{f.scheme}</div>;
    case "mime":     return <div class="truncate pr-2 opacity-70">{f.resContentType ?? f.reqContentType ?? "—"}</div>;
    case "client":   return (
      <div class={`flex items-center gap-1.5 truncate pr-2 ${f.clientApp ? "" : "opacity-40"}`}>
        {f.clientIcon
          ? <img src={f.clientIcon} alt="" class="h-4 w-4 rounded-sm shrink-0" />
          : <span class="h-4 w-4 rounded-sm bg-ink-100 dark:bg-ink-400/30 shrink-0 grid place-items-center text-ink-400 dark:text-ink-200">
              <AppWindow size={10} />
            </span>}
        <span class="truncate">{f.clientApp ?? "—"}</span>
      </div>
    );
  }
}

type Ctx = { id: string; x: number; y: number };

export default function FlowList(props: { flows: Flow[] }) {
  let parentRef!: HTMLDivElement;
  const rows = createMemo(() => props.flows);
  const [ctx, setCtx] = createSignal<Ctx | null>(null);
  const [dragId, setDragId] = createSignal<ColId | null>(null);
  const [dragOver, setDragOver] = createSignal<ColId | null>(null);

  const visibleCols = () => columnsStore.visible();
  const gridTemplate = () => visibleCols().map((c) => `${c.width}px`).join(" ");

  const virt = createVirtualizer({
    get count() { return rows().length; },
    getScrollElement: () => parentRef,
    estimateSize: () => 32,
    overscan: 12,
  });

  const onRowClick = (e: MouseEvent, id: string) => {
    if (e.shiftKey) flowsStore.selectRange(id, rows());
    else if (e.metaKey || e.ctrlKey) flowsStore.toggle(id);
    else flowsStore.selectSingle(id);
  };
  const onContext = (e: MouseEvent, id: string) => {
    e.preventDefault();
    if (!flowsStore.isSelected(id)) flowsStore.selectSingle(id);
    setCtx({ id, x: e.clientX, y: e.clientY });
  };
  const closeCtx = () => setCtx(null);

  const deleteSelected = async () => {
    const ids = flowsStore.selectedIds();
    if (ids.size === 0) return;
    await ipc.deleteFlows(Array.from(ids));
    flowsStore.removeMany(ids);
    closeCtx();
  };
  const markSelected = (color: string) => {
    flowsStore.selectedIds().forEach((id) => marksStore.set(id, color));
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
    <div class="h-full flex flex-col" onClick={closeCtx}>
      {/* Header */}
      <div
        class="grid h-9 items-center text-[10px] uppercase tracking-[0.12em] bg-ink-50/60 dark:bg-ink-600 border-b border-ink-100 dark:border-ink-400/30 mono opacity-80 px-3"
        style={{ "grid-template-columns": gridTemplate() }}
      >
        <For each={visibleCols()}>{(c) => {
          const sortState = sortStore.state;
          const isSorted = () => sortState().by === c.id;
          return (
            <div
              data-col-header={c.id}
              onMouseDown={(e) => startHeaderDrag(e, c.id)}
              class={`relative h-full flex items-center gap-1 pr-2 select-none cursor-grab active:cursor-grabbing
                ${dragOver() === c.id && dragId() !== c.id ? "bg-toucan-400/15 ring-2 ring-toucan-400/60 rounded" : ""}
                ${dragId() === c.id ? "opacity-50" : ""}
                ${isSorted() ? "text-toucan-400" : "hover:text-toucan-400"}`}
              title={`Click to sort · Drag to reorder · ${t(`col.${c.id}`)}`}
            >
              <span class="truncate">{t(`col.${c.id}`)}</span>
              {isSorted() && (sortState().dir === "asc"
                ? <ArrowUp size={11} />
                : <ArrowDown size={11} />)}
              <span
                onMouseDown={(e) => startResize(e, c.id, c.width)}
                onClick={(e) => e.stopPropagation()}
                class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-toucan-400/40"
              />
            </div>
          );
        }}</For>
      </div>

      {/* Rows */}
      <div ref={parentRef} class="flex-1 overflow-auto scroll-thin">
        <div style={{ height: `${virt.getTotalSize()}px`, position: "relative", width: "100%" }}>
          {virt.getVirtualItems().map((vi) => {
            const f = rows()[vi.index];
            const sel = flowsStore.isSelected(f.id);
            const markColor = colorOf(marksStore.marks()[f.id]);
            return (
              <div
                onClick={(e) => onRowClick(e, f.id)}
                onContextMenu={(e) => onContext(e, f.id)}
                style={{
                  position: "absolute", top: 0, left: 0, right: 0,
                  height: `${vi.size}px`, transform: `translateY(${vi.start}px)`,
                  background: markColor ? `${markColor}1f` : undefined,
                  "border-left": markColor ? `3px solid ${markColor}` : "3px solid transparent",
                  "grid-template-columns": gridTemplate(),
                }}
                class={`grid items-center text-xs mono cursor-pointer select-none pl-3 pr-3
                  ${sel ? "bg-toucan-400/20 text-toucan-400" : "hover:bg-ink-50 dark:hover:bg-ink-400/20"}
                  border-b border-ink-100/70 dark:border-ink-400/20`}
              >
                <For each={visibleCols()}>{(c) => renderCell(f, c.id)}</For>
              </div>
            );
          })}
          {rows().length === 0 && (
            <div class="absolute inset-0 grid place-items-center opacity-50 text-sm px-4 text-center">
              {t("list.empty", { port: flowsStore.status().port })}
            </div>
          )}
        </div>
      </div>

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
            <button onClick={deleteSelected}
              class="w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-red-500/10 hover:text-red-500">
              <span>{t("list.delete")}</span><span class="opacity-50 mono">⌫</span>
            </button>
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
    </div>
  );
}
