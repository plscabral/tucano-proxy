import { Trash2, Save, FileDown, FolderOpen, Tag, PanelRight, PanelBottom, EyeOff, Share2, GitCompareArrows, ChevronDown, Layers, RotateCcw } from "lucide-solid";
import { layoutStore, type InspectorPos } from "../stores/layout";
import ColumnsMenu from "./ColumnsMenu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { flowsStore } from "../stores/flows";
import { marksStore, MARK_COLORS } from "../stores/marks";
import { sessionStore } from "../stores/session";
import { prefsStore } from "../stores/prefs";
import { ipc } from "../lib/ipc";
import { COLLECTION_FORMATS } from "../lib/exporters";
import { createSignal, Show, For, createEffect, onCleanup, onMount } from "solid-js";
import { t } from "../lib/i18n";
import LlmExportDialog from "./LlmExportDialog";
import { undoStore } from "../stores/undo";
import type { Flow } from "../lib/types";

const KEEP_OPTIONS = [
  { label: "100",   short: "100",  value: 100 },
  { label: "250",   short: "250",  value: 250 },
  { label: "500",   short: "500",  value: 500 },
  { label: "1 000", short: "1k",   value: 1000 },
  { label: "5 000", short: "5k",   value: 5000 },
  { label: "10 000",short: "10k",  value: 10000 },
  { label: "All",   short: "All",  value: 0 },
];

export default function FlowToolbar(props: { count: number; flows: () => Flow[]; onCompare?: () => void }) {
  const [openMark, setOpenMark] = createSignal(false);
  const [openExport, setOpenExport] = createSignal(false);
  const [openRemove, setOpenRemove] = createSignal(false);
  const [openKeep, setOpenKeep] = createSignal(false);
  let exportRef: HTMLDivElement | undefined;
  let removeRef: HTMLDivElement | undefined;
  let keepRef: HTMLDivElement | undefined;

  onMount(async () => {
    try {
      const limit = await ipc.getKeepLimit();
      if (limit !== prefsStore.prefs().keepLimit) prefsStore.setKeepLimit(limit);
    } catch {}
  });


  createEffect(() => {
    if (!openExport()) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef && !exportRef.contains(e.target as Node)) setOpenExport(false);
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });
  createEffect(() => {
    if (!openRemove()) return;
    const onDown = (e: MouseEvent) => {
      if (removeRef && !removeRef.contains(e.target as Node)) setOpenRemove(false);
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });
  createEffect(() => {
    if (!openKeep()) return;
    const onDown = (e: MouseEvent) => {
      if (keepRef && !keepRef.contains(e.target as Node)) setOpenKeep(false);
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
  const removeByType = async (type: string) => {
    setOpenRemove(false);
    const all = flowsStore.flows();
    let toRemove: Flow[] = [];
    const marks = marksStore.marks();
    const BROWSERS = ["google chrome", "safari", "firefox", "microsoft edge", "opera", "brave"];
    const JS_TYPES = ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript"];
    const CSS_TYPES = ["text/css"];
    switch (type) {
      case "all": toRemove = all; break;
      case "images": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return ct.startsWith("image/")
          || ct.includes("icon")
          || /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?)$/.test(path)
          || path.includes("favicon");
      }); break;
      case "scripts": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return JS_TYPES.some((t) => ct.startsWith(t)) || /\.(js|mjs|cjs)$/.test(path);
      }); break;
      case "css": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return CSS_TYPES.some((t) => ct.startsWith(t)) || path.endsWith(".css");
      }); break;
      case "media":    toRemove = all.filter((f) => f.resContentType?.startsWith("video/") || f.resContentType?.startsWith("audio/")); break;
      case "fonts": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return ct.startsWith("font/")
          || ct.includes("font-")
          || ct.includes("fontobject")
          || ct === "application/font-woff"
          || ct === "application/font-woff2"
          || ct === "application/x-font-ttf"
          || ct === "application/x-font-opentype"
          || /\.(woff2?|ttf|otf|eot|sfnt)$/.test(path);
      }); break;
      case "connects": toRemove = all.filter((f) => f.method === "CONNECT"); break;
      case "4xx":      toRemove = all.filter((f) => f.status != null && f.status >= 400 && f.status < 500); break;
      case "5xx":      toRemove = all.filter((f) => f.status != null && f.status >= 500); break;
      case "non200":   toRemove = all.filter((f) => f.status != null && f.status !== 200); break;
      case "nonbrowser": toRemove = all.filter((f) => {
        if (!f.clientApp) return true;
        const a = f.clientApp.toLowerCase();
        return !BROWSERS.some((b) => a.includes(b));
      }); break;
      case "unmarked": toRemove = all.filter((f) => f.endedAt != null && !marks[f.id]); break;
      case "dupes": {
        const seen = new Set<string>();
        toRemove = all.filter((f) => {
          if (!f.resBody) return false;
          if (seen.has(f.resBody)) return true;
          seen.add(f.resBody);
          return false;
        });
        break;
      }
    }
    if (toRemove.length === 0) return;
    if (type === "all" && !confirm("Remove all captures?")) return;
    const ids = toRemove.map((f) => f.id);
    const snapshot = toRemove.slice();
    try {
      await ipc.deleteFlows(ids);
      flowsStore.removeMany(new Set(ids));
      if (type === "all") marksStore.clear();
      undoStore.push(snapshot);
    } catch (e) {
      console.error("removeByType failed", e);
    }
  };

  const setKeep = async (limit: number) => {
    setOpenKeep(false);
    prefsStore.setKeepLimit(limit);
    try {
      await ipc.setKeepLimit(limit);
    } catch (e) {
      console.error("setKeepLimit failed", e);
    }
  };

  const keepLabel = () => {
    const v = prefsStore.prefs().keepLimit;
    const opt = KEEP_OPTIONS.find((o) => o.value === v);
    return opt ? opt.short : "All";
  };
  const setMark = (colorId: string) => {
    flowsStore.selectedIds().forEach((id) => marksStore.set(id, colorId));
    setOpenMark(false);
  };
  const hasSelection = () => flowsStore.selectedIds().size > 0;
  const canCompare = () => flowsStore.selectedIds().size === 2;

  const [replaying, setReplaying] = createSignal(false);
  const replay = async () => {
    const id = flowsStore.anchorId() ?? flowsStore.selectedId();
    if (!id || replaying()) return;
    setReplaying(true);
    try { await ipc.replay(id, [], null); }
    catch (e) { console.error("replay failed", e); }
    finally { setReplaying(false); }
  };

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

  const Sep = () => <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-0.5 shrink-0" />;
  const tbBtn = (active = false) =>
    `h-8 px-2.5 rounded-xl text-xs flex items-center gap-1.5 transition shrink-0
     ${active
       ? "bg-toucan-400/15 text-toucan-400"
       : "opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`;

  return (
    <div class="h-11 flex items-stretch bg-ink-50/60 dark:bg-ink-600 border-b border-ink-100 dark:border-ink-400/30">

      {/* ── Esquerda: Keep · Replay · Remove · Compare · Mark · Colunas ── */}
      <div class="flex items-center gap-1 pl-2 shrink-0">

        {/* Keep */}
        <div class="relative" ref={keepRef}>
          <button onClick={() => setOpenKeep(!openKeep())} class={tbBtn(openKeep())}>
            <Layers size={13} /> Keep: {keepLabel()} <ChevronDown size={11} class="opacity-60" />
          </button>
          <Show when={openKeep()}>
            <div class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl py-1 min-w-[180px] text-xs">
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">Max sessions to keep</div>
              <For each={KEEP_OPTIONS}>{(opt) => (
                <button
                  onClick={() => setKeep(opt.value)}
                  class={`w-full px-3 py-1.5 text-left transition
                    ${prefsStore.prefs().keepLimit === opt.value
                      ? "text-toucan-400 bg-toucan-400/10"
                      : "hover:bg-toucan-400/10 hover:text-toucan-400"}`}
                >{opt.value === 0 ? "All sessions" : `${opt.label} sessions`}</button>
              )}</For>
            </div>
          </Show>
        </div>

        {/* Replay */}
        <button
          onClick={replay}
          disabled={!hasSelection() || replaying()}
          title="Replay selected request"
          class={`${tbBtn()} disabled:opacity-30`}
        >
          <RotateCcw size={13} class={replaying() ? "animate-spin" : ""} /> Replay
        </button>

        <Sep />

        {/* Remove */}
        <div class="relative" ref={removeRef}>
          <button onClick={() => setOpenRemove(!openRemove())}
            class={`${tbBtn(openRemove())} hover:bg-red-500/10 hover:text-red-500`}>
            <Trash2 size={13} /> Remove <ChevronDown size={11} class="opacity-60" />
          </button>
          <Show when={openRemove()}>
            <div class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl py-1 min-w-[210px] text-xs">
              <button onClick={() => removeByType("all")}
                class="w-full px-3 py-1.5 text-left font-medium hover:bg-red-500/10 hover:text-red-500 transition">
                Remove all
              </button>
              <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-40">By type</div>
              {([
                ["images",  "Images"],
                ["scripts", "JavaScript"],
                ["css",     "CSS"],
                ["fonts",   "Fonts"],
                ["media",   "Media (video / audio)"],
                ["connects","CONNECTs"],
              ] as [string, string][]).map(([type, label]) => (
                <button onClick={() => removeByType(type)}
                  class="w-full px-3 py-1.5 text-left hover:bg-red-500/10 hover:text-red-500 transition">
                  {label}
                </button>
              ))}
              <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-40">By status</div>
              {([
                ["non200", "Non-200s"],
                ["4xx",    "4xx Client errors"],
                ["5xx",    "5xx Server errors"],
              ] as [string, string][]).map(([type, label]) => (
                <button onClick={() => removeByType(type)}
                  class="w-full px-3 py-1.5 text-left hover:bg-red-500/10 hover:text-red-500 transition">
                  {label}
                </button>
              ))}
              <div class="my-1 border-t border-ink-100 dark:border-ink-400/30" />
              <div class="px-3 py-1 text-[10px] uppercase tracking-wider opacity-40">Other</div>
              {([
                ["nonbrowser", "Non-Browser"],
                ["unmarked",   "Complete & Unmarked"],
                ["dupes",      "Duplicate response bodies"],
              ] as [string, string][]).map(([type, label]) => (
                <button onClick={() => removeByType(type)}
                  class="w-full px-3 py-1.5 text-left hover:bg-red-500/10 hover:text-red-500 transition">
                  {label}
                </button>
              ))}
            </div>
          </Show>
        </div>

        {/* Compare */}
        <button
          onClick={() => props.onCompare?.()}
          disabled={!canCompare()}
          title={t("tb.compareTitle") || "Compare two captures (⌘D)"}
          class={`${tbBtn()} disabled:opacity-30`}
        >
          <GitCompareArrows size={13} /> {t("tb.compare") || "Compare"}
        </button>

        <Sep />

        {/* Mark */}
        <div class="relative">
          <button onClick={() => setOpenMark(!openMark())} disabled={!hasSelection()}
            title={t("tb.markTitle")}
            class={`${tbBtn(openMark())} disabled:opacity-30`}>
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

        {/* Exportar */}
        <div class="relative" ref={exportRef}>
          <button onClick={() => setOpenExport(!openExport())} title={t("tb.exportTitle")}
            class={tbBtn(openExport())}>
            <Share2 size={13} /> {t("tb.export")}
          </button>
          <Show when={openExport()}>
            <div class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl py-1 min-w-[240px] text-xs">
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

        {/* Colunas */}
        <ColumnsMenu />
      </div>

      {/* Spacer */}
      <div class="flex-1" />

      {/* ── Direita: Abrir · Salvar · Salvar Como ── */}
      <div class="flex items-center gap-1 px-1 shrink-0">
        <Sep />

        <button onClick={onOpen} title={t("tb.openTitle")} class={tbBtn()}>
          <FolderOpen size={13} /> {t("tb.open")}
        </button>
        <button onClick={onSave} title={sessionStore.path() ? t("tb.saveTitleBound", { path: sessionStore.path()! }) : t("tb.saveTitle")} class={tbBtn()}>
          <Save size={13} /> {t("tb.save")}
        </button>
        <button onClick={onSaveAs} title={t("tb.saveAsTitle")} class={tbBtn()}>
          <FileDown size={13} /> {t("tb.saveAs")}
        </button>

        <Show when={openLlm()}>
          <LlmExportDialog flows={flowsForExport} onClose={() => setOpenLlm(false)} />
        </Show>
      </div>

      {/* ── Count + layout ── */}
      <div class="flex items-center gap-1 px-2 shrink-0 border-l border-ink-100 dark:border-ink-400/30">
        <span class="text-[11px] opacity-50 mono px-1 whitespace-nowrap">{t("tb.countOf", { count: props.count, total: flowsStore.flows().length })}</span>
        <Sep />
        <LayoutBtn pos="right"  titleKey="tb.inspectorRight"  icon={<PanelRight size={14} />} />
        <LayoutBtn pos="bottom" titleKey="tb.inspectorBottom" icon={<PanelBottom size={14} />} />
        <LayoutBtn pos="hidden" titleKey="tb.inspectorHidden" icon={<EyeOff size={14} />} />
      </div>
    </div>
  );
}
