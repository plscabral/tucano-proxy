import { useEffect, useMemo, useRef, useState } from "react";
import { nativeWindow, confirm, save, open, isDesktop, canMutate, connect, listen, getConnection, preferenceStorage } from "@/lib/platform";
import { ConnectionBanner } from "@/components/PlatformGate";

import TopBar from "@/components/TopBar";
import StatusBar from "@/components/StatusBar";
import FlowList from "@/components/FlowList";
import Inspector from "@/components/Inspector";
import FilterBar from "@/components/FilterBar";
import Sidebar from "@/components/Sidebar";
import FlowToolbar from "@/components/FlowToolbar";
import Settings from "@/components/Settings";
import Splitter from "@/components/Splitter";
import Onboarding, { shouldShowOnboarding } from "@/components/Onboarding";
import CompareView from "@/components/CompareView";
import FindAllBar from "@/components/FindAllBar";
import Composer from "@/components/Composer";
import { TooltipProvider } from "@/components/ui/tooltip";

import { useFlows } from "@/stores/flows";
import { useSidebar } from "@/stores/sidebar";
import { useMarks, MARK_COLORS } from "@/stores/marks";
import { useRules } from "@/stores/rules";
import { useIgnored } from "@/stores/ignored";
import { useLayout } from "@/stores/layout";
import { useSort } from "@/stores/sort";
import { useUpdater } from "@/stores/updater";
import { usePrefs } from "@/stores/prefs";
import { useSession } from "@/stores/session";
import { useUndo } from "@/stores/undo";
import { useNote } from "@/stores/note";
import { useFindAll } from "@/stores/findAll";
import { useLocale } from "@/lib/i18n";
import "@/stores/theme"; // initialize theme (light/dark/system)

import { ipc, onFlowNew, onFlowUpdate, onFlowsTrimmed } from "@/lib/ipc";
import type { Flow } from "@/lib/types";
import { applyRules } from "@/lib/rules";
import { matchesCategory, CATEGORIES, type Category } from "@/lib/category";
import { sortFlows } from "@/lib/sortFlows";
import { t } from "@/lib/i18n";

export default function App() {
  // Re-render the whole tree on locale change so every `t(...)` call site picks
  // up the new strings without threading a hook through each one.
  useLocale((s) => s.locale);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(isDesktop && shouldShowOnboarding());
  const [compareOpen, setCompareOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerFlow, setComposerFlow] = useState<Flow | null>(null);
  const [openedFlowId, setOpenedFlowId] = useState<string | null>(null);

  // Reactive slices that drive the filter pipeline + layout.
  const flowsView = useFlows((s) => s.flowsView);
  const flows = useFlows((s) => s.flows);
  const selectedIds = useFlows((s) => s.selectedIds);
  const proxyPort = useFlows((s) => s.status.port);
  const captureRunning = useFlows((s) => s.status.running);
  const systemProxyOn = useFlows((s) => s.status.systemProxyOn);
  const apps = useSidebar((s) => s.selectedApps);
  const domains = useSidebar((s) => s.selectedDomains);
  const cats = useSidebar((s) => s.selectedCategories);
  const sidebarOpen = useSidebar((s) => s.open);
  const rules = useRules((s) => s.list);
  const matchMode = useRules((s) => s.matchMode);
  const sortBy = useSort((s) => s.by);
  const sortDir = useSort((s) => s.dir);
  const pos = useLayout((s) => s.pos);
  const rightPct = useLayout((s) => s.rightPct);
  const bottomPct = useLayout((s) => s.bottomPct);

  const openComposer = (flow?: Flow | null) => {
    setComposerFlow(flow ?? null);
    setComposerOpen(true);
  };

  const filtered = useMemo<Flow[]>(() => {
    const hasSidebarFilter = apps.size > 0 || domains.size > 0 || cats.size > 0;
    const byCat = flowsView.filter((f) => {
      if (hasSidebarFilter) {
        // OR within each group, AND across groups when multiple have selections.
        const appOk = apps.size === 0 || apps.has(f.clientApp ?? "");
        const domOk = domains.size === 0 || domains.has(f.host);
        const catOk = cats.size === 0 || [...cats].some((c) => matchesCategory(f, c as Category));
        if (!appOk || !domOk || !catOk) return false;
      }
      return true;
    });
    const byRules = applyRules(byCat, useRules.getState().list, matchMode);
    return sortFlows(byRules, sortBy, sortDir);
  }, [flowsView, apps, domains, cats, rules, matchMode, sortBy, sortDir]);

  const selected = useMemo<Flow | null>(() => {
    return openedFlowId ? useFlows.getState().getById(openedFlowId) : null;
    // recompute when the underlying flow updates (e.g. response completes)
  }, [openedFlowId, flows]);

  const compareFlows = useMemo(() => {
    const ids = Array.from(selectedIds);
    if (ids.length !== 2) return null;
    const a = useFlows.getState().getById(ids[0]);
    const b = useFlows.getState().getById(ids[1]);
    return a && b ? { a, b } : null;
  }, [selectedIds, flows]);

  const openCompare = () => {
    if (compareFlows) setCompareOpen(true);
  };

  // Refs so the once-bound keydown handler reads the latest values without
  // re-binding the listener on every capture frame.
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const openedFlowIdRef = useRef(openedFlowId);
  openedFlowIdRef.current = openedFlowId;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const onboardingOpenRef = useRef(onboardingOpen);
  onboardingOpenRef.current = onboardingOpen;

  const splitRef = useRef<HTMLDivElement>(null);
  const sidebarSplitRef = useRef<HTMLDivElement>(null);

  // --- Boot: initial load + auto-start + updater + window close hook ---
  useEffect(() => {
    if (!isDesktop) return;
    let unCloseFn: (() => void) | null = null;
    (async () => {
      const flowsStore = useFlows.getState();
      try {
        flowsStore.setStatus(await ipc.status());
        // Native proxy code reads this before it emits or writes any flow;
        // synchronize it before auto-capture can start.
        await ipc.setPrivateMode(usePrefs.getState().privateMode);
        const snapshot = await ipc.listFlows();
        const legacyMarks = preferenceStorage.getItem("tucano:marks");
        if (legacyMarks) {
          let marks: Record<string, string> = {};
          try { marks = JSON.parse(legacyMarks); } catch { /* Discard malformed legacy preferences. */ }
          await Promise.all(snapshot.map(async (flow) => {
            const mark = marks?.[flow.id];
            if (!flow.mark && typeof mark === "string" && MARK_COLORS.some((color) => color.id === mark && mark !== "none")) {
              await ipc.updateFlowMark(flow.id, mark);
              flow.mark = mark;
            }
          }));
          preferenceStorage.removeItem("tucano:marks");
        }
        flowsStore.setFlows(snapshot);
        const st = useFlows.getState().status;
        if (usePrefs.getState().autoCapture && !st.running) {
          try {
            await ipc.startCapture(usePrefs.getState().capturePort ?? st.port);
            flowsStore.setStatus(await ipc.status());
          } catch (e) { console.warn("auto-start capture failed", e); }
        }
      } catch (e) { console.warn("ipc unavailable?", e); }

      const updater = useUpdater.getState();
      updater.check()
        .then(() => {
          if (useUpdater.getState().state === "available") return useUpdater.getState().download();
        })
        .catch((e) => console.warn("[updater] boot check failed", e));

      try {
        const win = await nativeWindow();
        let busy = false;
        const un = await win.onCloseRequested(async (e) => {
          e.preventDefault();
          if (busy) return;
          busy = true;
          try {
            const fs = useFlows.getState();
            const flowsCount = fs.flows.length;
            const running = fs.status.running;
            const hasMarks = Object.keys(useMarks.getState().marks).length > 0;
            const unsaved = flowsCount > 0 && !useSession.getState().path;

            if (running || unsaved || hasMarks) {
              const ok = await confirm(
                running ? t("dlg.quitRunning", { n: flowsCount }) : t("dlg.quitUnsaved", { n: flowsCount }),
                { title: t("dlg.quitTitle"), kind: "warning", okLabel: t("dlg.quitOk"), cancelLabel: t("dlg.cancel") },
              );
              if (!ok) return;
            }
            if (useUpdater.getState().hasReadyUpdate()) {
              try { await useUpdater.getState().installOnQuit(); } catch (err) { console.warn(err); }
            }
            await ipc.quitApp();
          } finally {
            busy = false;
          }
        });
        unCloseFn = un;
      } catch (e) { console.warn("could not hook close", e); }
    })();
    return () => { unCloseFn?.(); };
  }, []);

  // --- Flow event stream: batch into one state update per animation frame ---
  useEffect(() => {
    let pending: Flow[] = [];
    let raf: number | null = null;
    let alive = true;
    let loading = false;
    let reloadAgain = false;
    let duringReload: Flow[] = [];
    const flush = () => {
      raf = null;
      if (!alive || !pending.length) return;
      useFlows.getState().batchUpsert(pending.splice(0));
    };
    const receive = (flow: Flow) => {
      const rules = useRules.getState();
      const active = rules.list.filter((rule) => rule.enabled && rule.value.trim() !== "");
      if (useIgnored.getState().matches(flow) || (rules.captureMode && active.length > 0 && applyRules([flow], active, rules.matchMode).length === 0)) {
        useFlows.getState().removeOneIfPresent(flow.id);
        if (canMutate()) void ipc.deleteFlows([flow.id]).catch(() => {});
        return;
      }
      if (loading) duringReload.push(flow);
      pending.push(flow);
      if (raf === null) raf = requestAnimationFrame(flush);
    };
    const resync = async () => {
      if (loading) { reloadAgain = true; return; }
      loading = true;
      duringReload = [];
      try {
        const [snapshot, status, privateMode] = await Promise.all([ipc.listFlows(), ipc.status(), ipc.getPrivateMode()]);
        if (!alive) return;
        // Apply events arriving during the snapshot after it; retain selection
        // and the open inspector while reconnecting to this same session.
        useFlows.getState().setFlows(snapshot.filter((flow) => !useIgnored.getState().matches(flow)));
        useFlows.getState().batchUpsert(duringReload);
        useFlows.getState().setStatus(status);
        usePrefs.getState().setPrivateMode(privateMode);
      } catch (error) { console.warn("Capture resync failed", error); }
      finally {
        loading = false;
        duringReload = [];
        if (reloadAgain && alive) { reloadAgain = false; void resync(); }
      }
    };
    const pNew = onFlowNew(receive);
    const pUp = onFlowUpdate(receive);
    const pTrimmed = onFlowsTrimmed((ids) => {
      const removed = new Set(ids);
      pending = pending.filter((flow) => !removed.has(flow.id));
      duringReload = duringReload.filter((flow) => !removed.has(flow.id));
      useFlows.getState().removeMany(removed);
      if (loading) reloadAgain = true;
    });
    const pReset = listen("flows:reset", () => {
      pending = []; duringReload = [];
      void resync();
    });
    const onResync = () => { void resync(); };
    window.addEventListener("tucano:resync", onResync);
    let polling = false;
    const timer = isDesktop ? null : window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        if (!["unauthorized", "detached"].includes(getConnection().state)) {
          if (getConnection().state !== "connected") await connect();
          useFlows.getState().setStatus(await ipc.status());
        }
      } catch { /* Connection state and recovery are displayed in the banner. */ }
      finally { polling = false; }
    }, 5000);
    return () => {
      alive = false;
      if (raf != null) cancelAnimationFrame(raf);
      if (timer != null) clearInterval(timer);
      window.removeEventListener("tucano:resync", onResync);
      for (const subscription of [pNew, pUp, pTrimmed, pReset]) void subscription.then((un) => un());
    };
  }, []);

  // --- Global keyboard shortcuts (bound once; reads refs + store getState) ---
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (useNote.getState().openId || onboardingOpenRef.current) return;
      if (settingsOpenRef.current) {
        if (e.key === "Escape") setSettingsOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useFindAll.getState().setOpen(true);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>("[data-findall-input]")?.focus();
        });
        return;
      }
      const target = e.target as HTMLElement | null;
      const ae = document.activeElement as HTMLElement | null;
      const inInspector =
        !!(target instanceof Element && target.closest("[data-inspector]")) ||
        !!(ae instanceof Element && ae.closest("[data-inspector]")) ||
        !!(target instanceof Element && target.closest(".cm-editor")) ||
        !!(ae instanceof Element && ae.closest(".cm-editor"));
      if (inInspector) return;
      const meta = e.metaKey || e.ctrlKey;
      const tag = target?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        tag === "BUTTON" || tag === "A" ||
        target?.isContentEditable === true ||
        !!target?.closest?.(".cm-editor");
      const mutatingShortcut = (meta && ["l", "o", "z", "0", "1", "2", "3", "4", "5", "6"].includes(e.key.toLowerCase())) ||
        (!inField && [" ", "Delete", "Backspace", "m"].includes(e.key));
      if (mutatingShortcut && !canMutate()) { e.preventDefault(); return; }

      const flowsStore = useFlows.getState();

      if (meta && e.key.toLowerCase() === "a" && !inField) {
        e.preventDefault();
        flowsStore.selectAll(filteredRef.current.map((f) => f.id));
        return;
      }
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.dispatchEvent(new Event("tucano:open-filters"));
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const list = useRules.getState().list;
        if (list.length > 0) useRules.getState().remove(list[list.length - 1].id);
      } else if (meta && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useSidebar.getState().toggleOpen();
      } else if (meta && e.key.toLowerCase() === "d") {
        const ids = Array.from(useFlows.getState().selectedIds);
        if (ids.length === 2) { e.preventDefault(); setCompareOpen(true); }
      } else if (meta && e.key === ",") {
        e.preventDefault(); setSettingsOpen(true);
      } else if (meta && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const yes = await confirm(t("dlg.clearMessage"), {
          title: t("dlg.clearTitle"), okLabel: t("dlg.clearOk"), cancelLabel: t("dlg.cancel"),
        });
        if (yes) {
          const snapshot = flowsStore.flows.slice();
          await ipc.clearFlows();
          flowsStore.clear();
          useMarks.getState().clear();
          useUndo.getState().push(snapshot);
        }
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!isDesktop && !useFlows.getState().flows.length) return;
        const p = await save({ defaultPath: "session.tucano", filters: [{ name: "Tucano", extensions: ["tucano"] }] });
        if (p) {
          const sel = useFlows.getState().selectedIds;
          const visible = filteredRef.current.map((f) => f.id);
          const ids = sel.size > 0 ? visible.filter((id) => sel.has(id)) : visible;
          await ipc.saveSession(p, ids);
        }
      } else if (meta && e.key.toLowerCase() === "o") {
        e.preventDefault();
        const p = await open({ multiple: false, filters: [{ name: "Tucano", extensions: ["tucano"] }] });
        if (p) {
          await ipc.openSession(p);
          const fs = useFlows.getState();
          fs.setFlows(await ipc.listFlows());
          fs.rebuildIndex();
        }
      } else if (e.key === "Escape") {
        if (settingsOpenRef.current) { setSettingsOpen(false); return; }
        if (openedFlowIdRef.current) { e.preventDefault(); setOpenedFlowId(null); flowsStore.clearSelection(); return; }
        if (useFindAll.getState().open) useFindAll.getState().close();
      } else if (!inField && e.key === " ") {
        e.preventDefault();
        const s = flowsStore.status;
        if (s.running) await ipc.stopCapture(); else await ipc.startCapture(usePrefs.getState().capturePort ?? s.port);
        flowsStore.setStatus(await ipc.status());
      } else if (!inField && (e.key === "Delete" || e.key === "Backspace")) {
        const ids = flowsStore.selectedIds;
        if (ids.size > 0) {
          e.preventDefault();
          const snapshot: Flow[] = [];
          const arr: string[] = [];
          for (const id of ids) {
            arr.push(id);
            const f = flowsStore.getById(id);
            if (f) snapshot.push(f);
          }
          try {
            await ipc.deleteFlows(arr);
            flowsStore.removeMany(ids);
            useUndo.getState().push(snapshot);
          } catch (error) { alert(String(error)); }
        }
      } else if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (useUndo.getState().canUndo()) {
          e.preventDefault();
          await useUndo.getState().undo();
        }
      } else if (meta && /^[0-6]$/.test(e.key)) {
        const ids = flowsStore.selectedIds;
        if (ids.size > 0) {
          e.preventDefault();
          const colorId = MARK_COLORS[parseInt(e.key, 10)]?.id;
          if (colorId) ids.forEach((id) => useMarks.getState().set(id, colorId));
        }
      } else if (!inField && e.key.toLowerCase() === "m" && !meta && !e.altKey) {
        const id = flowsStore.selectedId();
        if (id) { e.preventDefault(); useNote.getState().open(id); }
      } else if (!inField && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        const cat = CATEGORIES[idx];
        if (cat && cat.id !== "all") useSidebar.getState().toggleCategory(cat.id, false);
      }
    };
    const handleKey = (event: KeyboardEvent) => { void onKey(event).catch((error) => alert(String(error))); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const onDragRight = (cx: number, _cy: number, rect: DOMRect) => {
    const pct = ((cx - rect.left) / rect.width) * 100;
    useLayout.getState().setRightPct(Math.max(15, Math.min(85, pct)));
  };
  const onDragBottom = (_cx: number, cy: number, rect: DOMRect) => {
    const pct = ((rect.bottom - cy) / rect.height) * 100;
    useLayout.getState().setBottomPct(Math.max(15, Math.min(85, pct)));
  };

  // Composer is a standalone modal dialog (rendered below), so the split
  // panel only ever hosts the Inspector.
  const showSide = !!selected;
  const panel = (
    <Inspector
      flow={selected}
      onClose={() => { setOpenedFlowId(null); useFlows.getState().clearSelection(); }}
      onComposer={openComposer}
    />
  );
  const list = (
    <FlowList
      flows={filtered}
      onCompare={openCompare}
      onOpen={(id) => { setComposerOpen(false); setOpenedFlowId(id); }}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full flex flex-col bg-[var(--tcn-canvas)] text-ink-500 dark:text-ink-50">
        <TopBar onOpenSettings={() => setSettingsOpen(true)} />
        <ConnectionBanner port={proxyPort} running={captureRunning} systemProxyOn={systemProxyOn} />
        <FilterBar />
        <FlowToolbar count={filtered.length} flows={filtered} onCompare={openCompare} onCompose={() => openComposer()} />
        <FindAllBar />

        <div ref={sidebarSplitRef} className="flex-1 flex overflow-hidden min-h-0">
          {sidebarOpen && (
            <>
              <Sidebar />
              <Splitter
                orientation="vertical"
                containerRef={() => sidebarSplitRef.current}
                onDrag={(cx, _cy, rect) => useSidebar.getState().setWidth(cx - rect.left)}
              />
            </>
          )}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {pos === "right" && (
              <div ref={splitRef} className="flex-1 flex overflow-hidden">
                <div
                  style={{ width: showSide ? `${rightPct}%` : "100%" }}
                  className="overflow-hidden border-r border-ink-100 dark:border-ink-400/40"
                >
                  {list}
                </div>
                {showSide && (
                  <>
                    <Splitter orientation="vertical" containerRef={() => splitRef.current} onDrag={onDragRight} />
                    <div className="flex-1 overflow-hidden min-w-0">{panel}</div>
                  </>
                )}
              </div>
            )}

            {pos === "bottom" && (
              <div ref={splitRef} className="flex-1 flex flex-col overflow-hidden">
                <div
                  style={{ height: showSide ? `${100 - bottomPct}%` : "100%" }}
                  className="overflow-hidden border-b border-ink-100 dark:border-ink-400/40"
                >
                  {list}
                </div>
                {showSide && (
                  <>
                    <Splitter orientation="horizontal" containerRef={() => splitRef.current} onDrag={onDragBottom} />
                    <div className="flex-1 overflow-hidden min-h-0">{panel}</div>
                  </>
                )}
              </div>
            )}

            {pos === "hidden" && <div className="flex-1 overflow-hidden">{list}</div>}
          </div>
        </div>

        <StatusBar />
        <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

        {composerOpen && (
          <Composer onClose={() => setComposerOpen(false)} initialFlow={composerFlow} />
        )}

        {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)} />}
        {compareOpen && compareFlows && (
          <CompareView a={compareFlows.a} b={compareFlows.b} onClose={() => setCompareOpen(false)} />
        )}
      </div>
    </TooltipProvider>
  );
}
