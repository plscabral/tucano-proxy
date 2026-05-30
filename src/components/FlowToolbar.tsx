import { useEffect, useRef, useState } from "react";
import { Trash2, Save, FileDown, FolderOpen, Tag, PanelRight, PanelBottom, EyeOff, Share2, GitCompareArrows, ChevronDown, Layers, RotateCcw, PanelLeft } from "lucide-react";
import { useLayout, type InspectorPos } from "@/stores/layout";
import { useSidebar } from "@/stores/sidebar";
import ColumnsMenu from "./ColumnsMenu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useFlows } from "@/stores/flows";
import { useMarks, MARK_COLORS } from "@/stores/marks";
import { useSession } from "@/stores/session";
import { usePrefs } from "@/stores/prefs";
import { ipc } from "@/lib/ipc";
import { COLLECTION_FORMATS } from "@/lib/exporters";
import { t } from "@/lib/i18n";
import LlmExportDialog from "./LlmExportDialog";
import { useUndo } from "@/stores/undo";
import type { Flow } from "@/lib/types";

const KEEP_OPTIONS = [
  { label: "100", short: "100", value: 100 },
  { label: "250", short: "250", value: 250 },
  { label: "500", short: "500", value: 500 },
  { label: "1 000", short: "1k", value: 1000 },
  { label: "5 000", short: "5k", value: 5000 },
  { label: "10 000", short: "10k", value: 10000 },
  { label: "All", short: "All", value: 0 },
];

// Close a dropdown when clicking outside its container.
function useOutsideClose(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, ref, close]);
}

export default function FlowToolbar({ count, flows, onCompare }: { count: number; flows: Flow[]; onCompare?: () => void }) {
  const [openMark, setOpenMark] = useState(false);
  const [openExport, setOpenExport] = useState(false);
  const [openRemove, setOpenRemove] = useState(false);
  const [openKeep, setOpenKeep] = useState(false);
  const [openLlm, setOpenLlm] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const exportRef = useRef<HTMLDivElement>(null);
  const removeRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLDivElement>(null);

  const pos = useLayout((s) => s.pos);
  const sidebarOpen = useSidebar((s) => s.open);
  const selectedIds = useFlows((s) => s.selectedIds);
  const flowsViewLen = useFlows((s) => s.flowsView.length);
  const sessionPath = useSession((s) => s.path);
  const keepLimit = usePrefs((s) => s.keepLimit);

  useOutsideClose(openExport, exportRef, () => setOpenExport(false));
  useOutsideClose(openRemove, removeRef, () => setOpenRemove(false));
  useOutsideClose(openKeep, keepRef, () => setOpenKeep(false));

  useEffect(() => {
    (async () => {
      try {
        const limit = await ipc.getKeepLimit();
        if (limit !== usePrefs.getState().keepLimit) usePrefs.getState().setKeepLimit(limit);
      } catch {}
    })();
  }, []);

  const flowsForExport = (): Flow[] => {
    const ids = useFlows.getState().selectedIds;
    return ids.size > 0 ? flows.filter((f) => ids.has(f.id)) : flows;
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
    const fl = flowsForExport();
    if (fl.length === 0) return;
    const path = await save({ defaultPath: `tucano.${fmt.extension}`, filters: [{ name: fmt.label, extensions: [fmt.extension] }] });
    if (!path) return;
    try { await ipc.writeTextFile(path, fmt.build(fl)); }
    catch (e) { console.error("export failed", e); alert(String(e)); }
  };

  const promptSavePath = () => save({ defaultPath: useSession.getState().path ?? "session.tucano", filters: [{ name: "Tucano Session", extensions: ["tucano"] }] });
  const idsToPersist = () => {
    const ids = useFlows.getState().selectedIds;
    const visible = flows.map((f) => f.id);
    return ids.size > 0 ? visible.filter((id) => ids.has(id)) : visible;
  };
  const onSave = async () => {
    let path = useSession.getState().path;
    if (!path) {
      const picked = await promptSavePath();
      if (!picked) return;
      path = picked;
      useSession.getState().setPath(path);
    }
    await ipc.saveSession(path, idsToPersist());
  };
  const onSaveAs = async () => {
    const picked = await promptSavePath();
    if (!picked) return;
    await ipc.saveSession(picked, idsToPersist());
    useSession.getState().setPath(picked);
  };
  const onOpen = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Tucano Session", extensions: ["tucano"] }] });
    if (path && typeof path === "string") {
      await ipc.openSession(path);
      useFlows.getState().setFlows(await ipc.listFlows());
      useFlows.getState().rebuildIndex();
      useSession.getState().setPath(path);
    }
  };

  const removeByType = async (type: string) => {
    setOpenRemove(false);
    const all = useFlows.getState().flows;
    let toRemove: Flow[] = [];
    const marks = useMarks.getState().marks;
    const BROWSERS = ["google chrome", "safari", "firefox", "microsoft edge", "opera", "brave"];
    const JS_TYPES = ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript"];
    const CSS_TYPES = ["text/css"];
    switch (type) {
      case "all": toRemove = all; break;
      case "images": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return ct.startsWith("image/") || ct.includes("icon") || /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?)$/.test(path) || path.includes("favicon");
      }); break;
      case "scripts": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return JS_TYPES.some((x) => ct.startsWith(x)) || /\.(js|mjs|cjs)$/.test(path);
      }); break;
      case "css": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return CSS_TYPES.some((x) => ct.startsWith(x)) || path.endsWith(".css");
      }); break;
      case "media": toRemove = all.filter((f) => f.resContentType?.startsWith("video/") || f.resContentType?.startsWith("audio/")); break;
      case "fonts": toRemove = all.filter((f) => {
        const ct = f.resContentType ?? "";
        const path = f.path.toLowerCase().split("?")[0];
        return ct.startsWith("font/") || ct.includes("font-") || ct.includes("fontobject")
          || ct === "application/font-woff" || ct === "application/font-woff2"
          || ct === "application/x-font-ttf" || ct === "application/x-font-opentype"
          || /\.(woff2?|ttf|otf|eot|sfnt)$/.test(path);
      }); break;
      case "connects": toRemove = all.filter((f) => f.method === "CONNECT"); break;
      case "4xx": toRemove = all.filter((f) => f.status != null && f.status >= 400 && f.status < 500); break;
      case "5xx": toRemove = all.filter((f) => f.status != null && f.status >= 500); break;
      case "non200": toRemove = all.filter((f) => f.status != null && f.status !== 200); break;
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
      useFlows.getState().removeMany(new Set(ids));
      if (type === "all") useMarks.getState().clear();
      useUndo.getState().push(snapshot);
    } catch (e) { console.error("removeByType failed", e); }
  };

  const setKeep = async (limit: number) => {
    setOpenKeep(false);
    usePrefs.getState().setKeepLimit(limit);
    try { await ipc.setKeepLimit(limit); } catch (e) { console.error("setKeepLimit failed", e); }
  };
  const keepLabel = () => KEEP_OPTIONS.find((o) => o.value === keepLimit)?.short ?? "All";

  const setMark = (colorId: string) => {
    useFlows.getState().selectedIds.forEach((id) => useMarks.getState().set(id, colorId));
    setOpenMark(false);
  };
  const hasSelection = selectedIds.size > 0;
  const canCompare = selectedIds.size === 2;

  const replay = async () => {
    const id = useFlows.getState().anchorId ?? useFlows.getState().selectedId();
    if (!id || replaying) return;
    setReplaying(true);
    try { await ipc.replay(id, [], null); }
    catch (e) { console.error("replay failed", e); }
    finally { setReplaying(false); }
  };

  const Sep = () => <div className="w-px h-5 bg-ink-100/60 dark:bg-white/10 mx-0.5 shrink-0" />;
  const tbBtn = (active = false) =>
    `h-8 px-2.5 rounded-xl text-xs flex items-center gap-1.5 transition shrink-0
     ${active ? "bg-toucan-400/15 text-toucan-400 shadow-[inset_0_0_0_1px_rgba(106,87,224,0.18)]" : "opacity-70 hover:opacity-100 hover:bg-ink-100/60 dark:hover:bg-white/[0.05]"}`;
  const LayoutBtn = ({ p, titleKey, icon }: { p: InspectorPos; titleKey: string; icon: React.ReactNode }) => (
    <button
      onClick={() => useLayout.getState().setPos(p)}
      title={t(titleKey)}
      className={`h-8 w-8 grid place-items-center rounded-xl transition ${pos === p ? "bg-toucan-400/15 text-toucan-400" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
    >{icon}</button>
  );

  const removeGroups: [string, [string, string][]][] = [
    ["By type", [["images", "Images"], ["scripts", "JavaScript"], ["css", "CSS"], ["fonts", "Fonts"], ["media", "Media (video / audio)"], ["connects", "CONNECTs"]]],
    ["By status", [["non200", "Non-200s"], ["4xx", "4xx Client errors"], ["5xx", "5xx Server errors"]]],
    ["Other", [["nonbrowser", "Non-Browser"], ["unmarked", "Complete & Unmarked"], ["dupes", "Duplicate response bodies"]]],
  ];

  return (
    <div className="relative z-20 h-11 flex items-stretch tcn-glass border-b border-ink-100/40 dark:border-white/[0.05]">
      <div className="flex items-center gap-1 pl-2 shrink-0">
        <button onClick={() => useSidebar.getState().toggleOpen()} className={tbBtn(sidebarOpen)} title={t("sidebar.toggle")}><PanelLeft size={13} /></button>

        <div className="relative" ref={keepRef}>
          <button onClick={() => setOpenKeep(!openKeep)} className={tbBtn(openKeep)}>
            <Layers size={13} /> Keep: {keepLabel()} <ChevronDown size={11} className="opacity-60" />
          </button>
          {openKeep && (
            <div className="absolute z-30 top-10 left-0 tcn-glass-strong rounded-2xl shadow-elev py-1 min-w-[180px] text-xs">
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-50">Max sessions to keep</div>
              {KEEP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setKeep(opt.value)}
                  className={`w-full px-3 py-1.5 text-left transition ${keepLimit === opt.value ? "text-toucan-400 bg-toucan-400/10" : "hover:bg-toucan-400/10 hover:text-toucan-400"}`}
                >{opt.value === 0 ? "All sessions" : `${opt.label} sessions`}</button>
              ))}
            </div>
          )}
        </div>

        <button onClick={replay} disabled={!hasSelection || replaying} title="Replay selected request" className={`${tbBtn()} disabled:opacity-30`}>
          <RotateCcw size={13} className={replaying ? "animate-spin" : ""} /> Replay
        </button>

        <Sep />

        <div className="relative" ref={removeRef}>
          <button onClick={() => setOpenRemove(!openRemove)} className={`${tbBtn(openRemove)} hover:bg-red-500/10 hover:text-red-500`}>
            <Trash2 size={13} /> Remove <ChevronDown size={11} className="opacity-60" />
          </button>
          {openRemove && (
            <div className="absolute z-30 top-10 left-0 tcn-glass-strong rounded-2xl shadow-elev py-1 min-w-[210px] text-xs">
              <button onClick={() => removeByType("all")} className="w-full px-3 py-1.5 text-left font-medium hover:bg-red-500/10 hover:text-red-500 transition">Remove all</button>
              {removeGroups.map(([group, items]) => (
                <div key={group}>
                  <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-40">{group}</div>
                  {items.map(([type, label]) => (
                    <button key={type} onClick={() => removeByType(type)} className="w-full px-3 py-1.5 text-left hover:bg-red-500/10 hover:text-red-500 transition">{label}</button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <button onClick={() => onCompare?.()} disabled={!canCompare} title={t("tb.compareTitle") || "Compare two captures (⌘D)"} className={`${tbBtn()} disabled:opacity-30`}>
          <GitCompareArrows size={13} /> {t("tb.compare") || "Compare"}
        </button>

        <Sep />

        <div className="relative">
          <button onClick={() => setOpenMark(!openMark)} disabled={!hasSelection} title={t("tb.markTitle")} className={`${tbBtn(openMark)} disabled:opacity-30`}>
            <Tag size={13} /> {t("tb.mark")}
          </button>
          {openMark && hasSelection && (
            <div className="absolute z-30 top-10 left-0 tcn-glass-strong rounded-2xl shadow-elev p-1.5 flex gap-1">
              {MARK_COLORS.map((c) => (
                <button key={c.id} onClick={() => setMark(c.id)} title={t(`mark.${c.id}`)} className="h-8 w-8 rounded-lg grid place-items-center hover:bg-ink-50 dark:hover:bg-ink-400/20">
                  <span className={`block h-4 w-4 rounded-full ${c.id === "none" ? "border border-dashed border-current opacity-50" : ""}`} style={{ background: c.color }} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative" ref={exportRef}>
          <button onClick={() => setOpenExport(!openExport)} title={t("tb.exportTitle")} className={tbBtn(openExport)}>
            <Share2 size={13} /> {t("tb.export")}
          </button>
          {openExport && (
            <div className="absolute z-30 top-10 left-0 tcn-glass-strong rounded-2xl shadow-elev py-1 min-w-[240px] text-xs">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider opacity-50">
                {selectedIds.size > 0 ? t("tb.exportSelected", { n: flowsForExport().length }) : t("tb.exportAll", { n: flows.length })}
              </div>
              {COLLECTION_FORMATS.map((fmt) => (
                <button key={fmt.id} onClick={() => exportCollection(fmt.id)} className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition">{fmt.label}</button>
              ))}
              <div className="my-1 border-t border-ink-100 dark:border-ink-400/30" />
              <button onClick={openLlmDialog} className="w-full px-3 py-1.5 text-left hover:bg-toucan-400/10 hover:text-toucan-400 transition">{t("tb.export.llm.menu")}</button>
            </div>
          )}
        </div>

        <ColumnsMenu />
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1 px-1 shrink-0">
        <Sep />
        <button onClick={onOpen} title={t("tb.openTitle")} className={tbBtn()}><FolderOpen size={13} /> {t("tb.open")}</button>
        <button onClick={onSave} title={sessionPath ? t("tb.saveTitleBound", { path: sessionPath }) : t("tb.saveTitle")} className={tbBtn()}><Save size={13} /> {t("tb.save")}</button>
        <button onClick={onSaveAs} title={t("tb.saveAsTitle")} className={tbBtn()}><FileDown size={13} /> {t("tb.saveAs")}</button>
        {openLlm && <LlmExportDialog flows={flowsForExport} onClose={() => setOpenLlm(false)} />}
      </div>

      <div className="flex items-center gap-1 px-2 shrink-0 border-l border-ink-100 dark:border-ink-400/30">
        <span className="text-[11px] opacity-50 mono px-1 whitespace-nowrap">{t("tb.countOf", { count, total: flowsViewLen })}</span>
        <Sep />
        <LayoutBtn p="right" titleKey="tb.inspectorRight" icon={<PanelRight size={14} />} />
        <LayoutBtn p="bottom" titleKey="tb.inspectorBottom" icon={<PanelBottom size={14} />} />
        <LayoutBtn p="hidden" titleKey="tb.inspectorHidden" icon={<EyeOff size={14} />} />
      </div>
    </div>
  );
}
