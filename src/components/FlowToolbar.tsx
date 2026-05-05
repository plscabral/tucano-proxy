import { Trash2, Save, FileDown, FolderOpen, Tag, PanelRight, PanelBottom, EyeOff, Share2, GitCompareArrows } from "lucide-solid";
import { layoutStore, type InspectorPos } from "../stores/layout";
import ColumnsMenu from "./ColumnsMenu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { flowsStore } from "../stores/flows";
import { marksStore, MARK_COLORS } from "../stores/marks";
import { sessionStore } from "../stores/session";
import { ipc } from "../lib/ipc";
import { COLLECTION_FORMATS } from "../lib/exporters";
import { createSignal, Show, For, createEffect, onCleanup } from "solid-js";
import { t } from "../lib/i18n";
import LlmExportDialog from "./LlmExportDialog";
import { undoStore } from "../stores/undo";
import type { Flow } from "../lib/types";

export default function FlowToolbar(props: { count: number; flows: () => Flow[]; onCompare?: () => void }) {
  const [openMark, setOpenMark] = createSignal(false);
  const [openExport, setOpenExport] = createSignal(false);
  let exportRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (!openExport()) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef && !exportRef.contains(e.target as Node)) setOpenExport(false);
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });
  const [openLlm, setOpenLlm] = createSignal(false);

  // Export always operates on what's visible in the list (filters/category/sort
  // already applied). When the user has an active selection, narrow further to
  // selected items intersected with what's visible.
  const flowsForExport = () => {
    const visible = props.flows();
    const ids = flowsStore.selectedIds();
    return ids.size > 0 ? visible.filter((f) => ids.has(f.id)) : visible;
  };
  const openLlmDialog = () => {
    setOpenExport(false);
    if (flowsForExport().length === 0) return;
    setOpenLlm(true);
  };

  const exportCollection = async (id: string) => {
    const fmt = COLLECTION_FORMATS.find((f) => f.id === id);
    if (!fmt) return;
    setOpenExport(false);
    const flows = flowsForExport();
    if (flows.length === 0) return;
    const path = await save({
      defaultPath: `tucano.${fmt.extension}`,
      filters: [{ name: fmt.label, extensions: [fmt.extension] }],
    });
    if (!path) return;
    try {
      await ipc.writeTextFile(path, fmt.build(flows));
    } catch (e) { console.error("export failed", e); alert(String(e)); }
  };

  const promptSavePath = () => save({
    defaultPath: sessionStore.path() ?? "session.tucano",
    filters: [{ name: "Tucano Session", extensions: ["tucano"] }],
  });
  // Save respects what's visible: only flows currently shown (filters/category
  // applied) are written. If a selection exists, it narrows further. This
  // matches the export behavior — "what you see is what you save."
  const visibleIds = () => props.flows().map((f) => f.id);
  const idsToPersist = () => {
    const ids = flowsStore.selectedIds();
    return ids.size > 0 ? visibleIds().filter((id) => ids.has(id)) : visibleIds();
  };
  // Save: silent overwrite if we already have a bound path; otherwise prompt.
  const onSave = async () => {
    let path = sessionStore.path();
    if (!path) {
      const picked = await promptSavePath();
      if (!picked) return;
      path = picked;
      sessionStore.setPath(path);
    }
    await ipc.saveSession(path, idsToPersist());
  };
  // Save As: always prompt; updates the bound path on success.
  const onSaveAs = async () => {
    const picked = await promptSavePath();
    if (!picked) return;
    await ipc.saveSession(picked, idsToPersist());
    sessionStore.setPath(picked);
  };
  const onOpen = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Tucano Session", extensions: ["tucano"] }] });
    if (path && typeof path === "string") {
      await ipc.openSession(path);
      flowsStore.setFlows(await ipc.listFlows());
      sessionStore.setPath(path);
    }
  };
  const clear = async () => {
    if (!confirm(t("tb.clearTitle"))) return;
    const snapshot = flowsStore.flows().slice();
    await ipc.clearFlows();
    flowsStore.clear();
    marksStore.clear();
    undoStore.push(snapshot);
  };
  const setMark = (colorId: string) => {
    flowsStore.selectedIds().forEach((id) => marksStore.set(id, colorId));
    setOpenMark(false);
  };
  const hasSelection = () => flowsStore.selectedIds().size > 0;
  const canCompare = () => flowsStore.selectedIds().size === 2;

  function LayoutBtn(p: { pos: InspectorPos; titleKey: string; icon: any }) {
    const active = () => layoutStore.pos() === p.pos;
    return (
      <button
        onClick={() => layoutStore.setPos(p.pos)}
        title={t(p.titleKey)}
        class={`h-8 w-8 grid place-items-center rounded-xl transition
          ${active() ? "bg-toucan-400/15 text-toucan-400" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
      >{p.icon}</button>
    );
  }

  return (
    <div class="h-11 px-3 flex items-center gap-1.5 bg-ink-50/60 dark:bg-ink-600 border-b border-ink-100 dark:border-ink-400/30 relative">
      <button onClick={clear} title={t("tb.clearTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-red-500/10 hover:text-red-500 transition">
        <Trash2 size={13} /> {t("tb.clear")}
      </button>

      <div class="relative">
        <button onClick={() => setOpenMark(!openMark())} disabled={!hasSelection()}
          title={t("tb.markTitle")}
          class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-toucan-400/10 hover:text-toucan-400 disabled:opacity-40 transition">
          <Tag size={13} /> {t("tb.mark")}
        </button>
        <Show when={openMark() && hasSelection()}>
          <div class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl p-1.5 flex gap-1">
            <For each={MARK_COLORS}>{(c) => (
              <button
                onClick={() => setMark(c.id)}
                title={t(`mark.${c.id}`)}
                class="h-8 w-8 rounded-lg grid place-items-center hover:bg-ink-50 dark:hover:bg-ink-400/20"
              >
                <span class={`block h-4 w-4 rounded-full ${c.id === "none" ? "border border-dashed border-current opacity-50" : ""}`}
                  style={{ background: c.color }} />
              </button>
            )}</For>
          </div>
        </Show>
      </div>

      <button
        onClick={() => props.onCompare?.()}
        disabled={!canCompare()}
        title={t("tb.compareTitle") || "Compare two captures (⌘D)"}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-toucan-400/10 hover:text-toucan-400 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-current transition"
      >
        <GitCompareArrows size={13} /> {t("tb.compare") || "Compare"}
      </button>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1.5" />

      <button onClick={onOpen} title={t("tb.openTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
        <FolderOpen size={13} /> {t("tb.open")}
      </button>
      <button onClick={onSave} title={sessionStore.path() ? t("tb.saveTitleBound", { path: sessionStore.path()! }) : t("tb.saveTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
        <Save size={13} /> {t("tb.save")}
      </button>
      <button onClick={onSaveAs} title={t("tb.saveAsTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
        <FileDown size={13} /> {t("tb.saveAs")}
      </button>

      <div class="relative" ref={exportRef}>
        <button onClick={() => setOpenExport(!openExport())} title={t("tb.exportTitle")}
          class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
          <Share2 size={13} /> {t("tb.export")}
        </button>
        <Show when={openExport()}>
          <div
            class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl py-1 min-w-[240px] text-xs"
          >
            <div class="px-3 py-1.5 text-[10px] uppercase tracking-wider opacity-50">
              {flowsStore.selectedIds().size > 0
                ? t("tb.exportSelected", { n: flowsForExport().length })
                : t("tb.exportAll", { n: props.flows().length })}
            </div>
            <For each={COLLECTION_FORMATS}>{(fmt) => (
              <button
                onClick={() => exportCollection(fmt.id)}
                class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition"
              >{fmt.label}</button>
            )}</For>
            <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
            <button
              onClick={openLlmDialog}
              class="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition"
            >{t("tb.export.llm.menu")}</button>
          </div>
        </Show>
      </div>

      <Show when={openLlm()}>
        <LlmExportDialog flows={flowsForExport} onClose={() => setOpenLlm(false)} />
      </Show>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1.5" />
      <ColumnsMenu />

      <div class="flex-1" />
      <span class="text-[11px] opacity-50 mono pr-2">{t("tb.countOf", { count: props.count, total: flowsStore.flows().length })}</span>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1" />

      <LayoutBtn pos="right"  titleKey="tb.inspectorRight"  icon={<PanelRight size={14} />} />
      <LayoutBtn pos="bottom" titleKey="tb.inspectorBottom" icon={<PanelBottom size={14} />} />
      <LayoutBtn pos="hidden" titleKey="tb.inspectorHidden" icon={<EyeOff size={14} />} />
    </div>
  );
}
