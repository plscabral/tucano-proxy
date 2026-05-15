import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import FlowList from "./components/FlowList";
import Inspector from "./components/Inspector";
import FilterBar from "./components/FilterBar";
import Sidebar from "./components/Sidebar";
import { sidebarStore } from "./stores/sidebar";
import FlowToolbar from "./components/FlowToolbar";
import Settings from "./components/Settings";
import Splitter from "./components/Splitter";
import Onboarding, { shouldShowOnboarding } from "./components/Onboarding";
import CompareView from "./components/CompareView";
import FindAllBar from "./components/FindAllBar";
import Composer from "./components/Composer";
import { findAllStore } from "./stores/findAll";
import { flowsStore } from "./stores/flows";
import { marksStore, MARK_COLORS } from "./stores/marks";
import { ipc, onFlowNew, onFlowUpdate, onFlowsTrimmed } from "./lib/ipc";
import type { Flow } from "./lib/types";
import { applyRules } from "./lib/rules";
import { rulesStore } from "./stores/rules";
import { matchesCategory, CATEGORIES, type Category } from "./lib/category";
import { layoutStore } from "./stores/layout";
import { sortStore } from "./stores/sort";
import { sortFlows } from "./lib/sortFlows";
import { updaterStore } from "./stores/updater";
import { prefsStore } from "./stores/prefs";
import { sessionStore } from "./stores/session";
import { undoStore } from "./stores/undo";
import { noteStore } from "./stores/note";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { t } from "./lib/i18n";

export default function App() {
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [onboardingOpen, setOnboardingOpen] = createSignal(shouldShowOnboarding());
  const [compareOpen, setCompareOpen] = createSignal(false);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [composerFlow, setComposerFlow] = createSignal<Flow | null>(null);
  const [openedFlowId, setOpenedFlowId] = createSignal<string | null>(null);

  const openComposer = (flow?: Flow | null) => {
    setComposerFlow(flow ?? null);
    setComposerOpen(true);
  };

  const compareFlows = createMemo(() => {
    const ids = Array.from(flowsStore.selectedIds());
    if (ids.length !== 2) return null;
    const all = flowsStore.flows();
    const a = all.find((f) => f.id === ids[0]);
    const b = all.find((f) => f.id === ids[1]);
    return a && b ? { a, b } : null;
  });
  const openCompare = () => {
    if (compareFlows()) setCompareOpen(true);
  };
  let splitRef!: HTMLDivElement;
  let sidebarSplitRef!: HTMLDivElement;

  onMount(async () => {
    try {
      flowsStore.setStatus(await ipc.status());
      flowsStore.setFlows(await ipc.listFlows());
      flowsStore.rebuildIndex();
      // Fiddler-style auto-start: bring up proxy + system proxy as soon as
      // the window is ready, so the user is debugging immediately. Skipped
      // if the user disabled it in Settings, or if something is already
      // running (rehydration after a crash).
      const st = flowsStore.status();
      if (prefsStore.prefs().autoCapture && !st.running) {
        try {
          await ipc.startCapture(st.port);
          flowsStore.setStatus(await ipc.status());
        } catch (e) { console.warn("auto-start capture failed", e); }
      }
    } catch (e) { console.warn("ipc unavailable?", e); }

    // Background update check on boot — silent on failure. If a new
    // version exists, download it so it's ready by the time the user
    // notices the StatusBar indicator.
    updaterStore.check()
      .then(() => {
        if (updaterStore.state() === "available") return updaterStore.download();
      })
      .catch((e) => console.warn("[updater] boot check failed", e));

    // Hook the window close (Cmd+Q, red traffic light, app quit). We:
    //   1. Confirm before quitting if there's unsaved work — captures sitting
    //      in memory that aren't bound to a session file, the proxy still
    //      capturing, or any user-applied marks. Cmd+Q is one keystroke
    //      away from any other shortcut, easy to hit by accident.
    //   2. If there's an update downloaded and waiting, apply it before
    //      exiting so the next launch is already on the new version.
    try {
      const win = getCurrentWindow();
      // Guard against re-entry: macOS fires CloseRequested every time the
      // user re-hits Cmd+Q, even while we're awaiting confirm(). We hold
      // this flag for the ENTIRE decision flow (including the "user clicked
      // Cancel" return) so a second event can't slip through and open a
      // duplicate dialog while the first is still being dismissed.
      let busy = false;
      await win.onCloseRequested(async (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        try {
          const flowsCount = flowsStore.flows().length;
          const running = flowsStore.status().running;
          const hasMarks = Object.keys(marksStore.marks()).length > 0;
          const unsaved = flowsCount > 0 && !sessionStore.path();

          if (running || unsaved || hasMarks) {
            const ok = await confirm(
              running
                ? t("dlg.quitRunning", { n: flowsCount })
                : t("dlg.quitUnsaved", { n: flowsCount }),
              {
                title: t("dlg.quitTitle"),
                kind: "warning",
                okLabel: t("dlg.quitOk"),
                cancelLabel: t("dlg.cancel"),
              },
            );
            if (!ok) return; // user cancelled — `busy` clears in `finally`
          }

          if (updaterStore.hasReadyUpdate()) {
            try { await updaterStore.installOnQuit(); } catch (err) { console.warn(err); }
          }

          await ipc.quitApp();
        } finally {
          busy = false;
        }
      });
    } catch (e) { console.warn("could not hook close", e); }
  });

  // Batch incoming flow events into a single state update per animation frame.
  // Without batching, 50+ flows/sec each trigger a full sort+filter in the
  // `filtered` memo, which freezes the UI during active capture.
  let _pending: Flow[] = [];
  let _raf: number | null = null;
  const scheduleFlush = (f: Flow) => {
    _pending.push(f);
    if (_raf === null) {
      _raf = requestAnimationFrame(() => {
        _raf = null;
        const batch = _pending.splice(0);
        flowsStore.batchUpsert(batch);
      });
    }
  };
  const unNew = onFlowNew(scheduleFlush);
  const unUp = onFlowUpdate((f) => {
    // Capture-filter mode: if the user toggled "drop non-matching at capture
    // time", evaluate the active rules against the now-complete flow and
    // delete it from both UI and Rust storage. Keeps the MCP storage small.
    if (rulesStore.captureMode()) {
      const active = rulesStore.rules().filter((r) => r.enabled && r.value.trim() !== "");
      if (active.length > 0 && applyRules([f], active, rulesStore.matchMode()).length === 0) {
        flowsStore.removeMany(new Set([f.id]));
        ipc.deleteFlows([f.id]).catch(() => {});
        return;
      }
    }
    scheduleFlush(f);
  });
  const unTrimmed = onFlowsTrimmed((ids) => flowsStore.removeMany(new Set(ids)));

  const onKey = async (e: KeyboardEvent) => {
    // When a modal is open, keep all keystrokes scoped to the dialog —
    // global shortcuts (Cmd+A, Space, etc.) must not leak through to the
    // background flow list.
    if (noteStore.openId() || onboardingOpen()) return;
    if (settingsOpen()) {
      if (e.key === "Escape") setSettingsOpen(false);
      return;
    }
    // Find All is global — fires from anywhere (grid, inspector, find bars).
    // Handled before the in-inspector early return so Cmd+Shift+F works
    // regardless of where focus currently is.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      findAllStore.setOpen(true);
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>("[data-findall-input]")?.focus();
      });
      return;
    }
    // The Inspector pane owns its own keystrokes — CodeMirror search,
    // Cmd+A inside source/JSON, etc. Never apply global shortcuts when
    // either the event target OR the currently focused element is inside
    // an inspector. Checking both is necessary: in WKWebView the keydown
    // target can fall back to document/body even though focus is on a
    // contenteditable child.
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
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      // Buttons / links: let the browser dispatch native activation
      // (Space/Enter on a focused button = click). Otherwise the global
      // Space shortcut would double-toggle the capture button.
      tag === "BUTTON" ||
      tag === "A" ||
      target?.isContentEditable === true ||
      // CodeMirror editors host content in a contenteditable div but
      // events can also originate from gutters/scrollers — treat anything
      // inside an editor as "in field" so Cmd+A selects code, not flows.
      !!target?.closest?.(".cm-editor");

    if (meta && e.key.toLowerCase() === "a" && !inField) {
      e.preventDefault();
      flowsStore.selectAll(filtered().map((f) => f.id));
      return;
    }
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (rulesStore.rules().length === 0) {
        const { newRule } = await import("./lib/rules");
        rulesStore.add(newRule());
      }
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>("[data-filter-input]");
        inputs[inputs.length - 1]?.focus();
      }, 0);
    } else if (meta && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const list = rulesStore.rules();
      if (list.length > 0) rulesStore.remove(list[list.length - 1].id);
    } else if (meta && e.key.toLowerCase() === "b") {
      e.preventDefault();
      sidebarStore.toggleOpen();
    } else if (meta && e.key.toLowerCase() === "d") {
      if (compareFlows()) { e.preventDefault(); setCompareOpen(true); }
    } else if (meta && e.key === ",") {
      e.preventDefault(); setSettingsOpen(true);
    } else if (meta && e.key.toLowerCase() === "l") {
      e.preventDefault();
      const yes = await confirm(t("dlg.clearMessage"), {
        title: t("dlg.clearTitle"),
        okLabel: t("dlg.clearOk"),
        cancelLabel: t("dlg.cancel"),
      });
      if (yes) {
        const snapshot = flowsStore.flows().slice();
        await ipc.clearFlows();
        flowsStore.clear();
        marksStore.clear();
        undoStore.push(snapshot);
      }
    } else if (meta && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const { save } = await import("@tauri-apps/plugin-dialog");
      const p = await save({ defaultPath: "session.tucano", filters: [{ name: "Tucano", extensions: ["tucano"] }] });
      if (p) {
        const sel = flowsStore.selectedIds();
        const visible = filtered().map((f) => f.id);
        const ids = sel.size > 0 ? visible.filter((id) => sel.has(id)) : visible;
        await ipc.saveSession(p, ids);
      }
    } else if (meta && e.key.toLowerCase() === "o") {
      e.preventDefault();
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ multiple: false, filters: [{ name: "Tucano", extensions: ["tucano"] }] });
      if (p && typeof p === "string") {
        await ipc.openSession(p);
        flowsStore.setFlows(await ipc.listFlows());
        flowsStore.rebuildIndex();
      }
    } else if (e.key === "Escape") {
      if (settingsOpen()) { setSettingsOpen(false); return; }
      if (selected()) { e.preventDefault(); setOpenedFlowId(null); flowsStore.clearSelection(); return; }
      if (findAllStore.open()) findAllStore.close();
    } else if (!inField && e.key === " ") {
      e.preventDefault();
      const s = flowsStore.status();
      if (s.running) await ipc.stopCapture(); else await ipc.startCapture(s.port);
      flowsStore.setStatus(await ipc.status());
    } else if (!inField && (e.key === "Delete" || e.key === "Backspace")) {
      const ids = flowsStore.selectedIds();
      if (ids.size > 0) {
        e.preventDefault();
        // Snapshot via O(m) id lookup instead of O(n) filter — with 3000
        // selected and 3000 total this is the difference between scanning
        // 9M comparisons and 3K hash lookups.
        const snapshot: Flow[] = [];
        const arr: string[] = [];
        for (const id of ids) {
          arr.push(id);
          const f = flowsStore.getById(id);
          if (f) snapshot.push(f);
        }
        // Optimistic UI: clear locally first so the user sees instant
        // response. The backend delete fires in the background; if it
        // fails we just log — undo can resurrect them anyway.
        flowsStore.removeMany(ids);
        undoStore.push(snapshot);
        void ipc.deleteFlows(arr).catch((err) => {
          console.warn("ipc.deleteFlows failed", err);
        });
      }
    } else if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
      if (undoStore.canUndo()) {
        e.preventDefault();
        await undoStore.undo();
      }
    } else if (meta && /^[0-6]$/.test(e.key)) {
      // Cmd/Ctrl + 0..6 → mark selected flows with the matching color
      const ids = flowsStore.selectedIds();
      if (ids.size > 0) {
        e.preventDefault();
        const colorId = MARK_COLORS[parseInt(e.key, 10)]?.id;
        if (colorId) ids.forEach((id) => marksStore.set(id, colorId));
      }
    } else if (!inField && e.key.toLowerCase() === "m" && !meta && !e.altKey) {
      const id = flowsStore.selectedId();
      if (id) { e.preventDefault(); noteStore.open(id); }
    } else if (!inField && /^[1-9]$/.test(e.key)) {
      // Number-key category shortcut now drives the sidebar Types group.
      // Pressing the same number twice clears it (toggle off).
      const idx = parseInt(e.key, 10) - 1;
      const cat = CATEGORIES[idx];
      if (cat && cat.id !== "all") sidebarStore.toggleCategory(cat.id, false);
    }
  };
  window.addEventListener("keydown", onKey);

  onCleanup(async () => {
    window.removeEventListener("keydown", onKey);
    (await unNew)(); (await unUp)(); (await unTrimmed)();
  });

  // Throttled mirror of flowsStore.flows() — refreshes the visible list at ~6 fps
  // while capture is running, so the filter+rules+sort+virtualizer pipeline
  // doesn't re-run on every batchUpsert. Instant when the proxy is stopped.
  const [flowsView, setFlowsView] = createSignal<Flow[]>(flowsStore.flows());
  let viewTimer: number | null = null;
  createEffect(() => {
    const next = flowsStore.flows();
    const running = flowsStore.status().running;
    const cur = untrack(flowsView);
    // Shrinks (delete, clear, undo, trim) bypass the throttle — they're
    // direct user actions that must paint instantly. Without this, hitting
    // Backspace on 3000 selected rows during active capture leaves the
    // list visible for up to 180ms before clearing, which feels like lag.
    if (!running || next.length < cur.length) {
      if (viewTimer != null) { clearTimeout(viewTimer); viewTimer = null; }
      setFlowsView(next);
      return;
    }
    if (viewTimer != null) return;
    viewTimer = window.setTimeout(() => {
      viewTimer = null;
      setFlowsView(flowsStore.flows());
    }, 180);
  });
  onCleanup(() => { if (viewTimer != null) clearTimeout(viewTimer); });

  const filtered = createMemo(() => {
    const apps = sidebarStore.selectedApps();
    const domains = sidebarStore.selectedDomains();
    const cats = sidebarStore.selectedCategories();
    const hasSidebarFilter = apps.size > 0 || domains.size > 0 || cats.size > 0;
    const byCat = flowsView().filter((f) => {
      if (hasSidebarFilter) {
        // Sidebar selection acts as OR within each group, AND across groups
        // when multiple have selections — same as Proxyman. The common case
        // is selecting one or two, where the empty-group check short-circuits.
        const appOk = apps.size === 0 || apps.has(f.clientApp ?? "");
        const domOk = domains.size === 0 || domains.has(f.host);
        const catOk = cats.size === 0 || [...cats].some((c) => matchesCategory(f, c as Category));
        if (!appOk || !domOk || !catOk) return false;
      }
      return true;
    });
    const byRules = applyRules(byCat, rulesStore.rules(), rulesStore.matchMode());
    const s = sortStore.state();
    return sortFlows(byRules, s.by, s.dir);
  });
  const selected = createMemo(() => {
    const id = openedFlowId();
    return id ? flowsStore.getById(id) : null;
  });

  const onDragRight = (cx: number, _cy: number, rect: DOMRect) => {
    // rightPct = width % taken by the LEFT panel (FlowList). Drag right
    // grows the list; drag left shrinks it. Clamp so neither side vanishes.
    const pct = ((cx - rect.left) / rect.width) * 100;
    layoutStore.setRightPct(Math.max(15, Math.min(85, pct)));
  };
  const onDragBottom = (_cx: number, cy: number, rect: DOMRect) => {
    // bottomPct = height % taken by the BOTTOM panel (Inspector). The
    // FlowList renders with `100 - bottomPct`, so dragging UP must grow
    // bottomPct. We measure distance from the bottom edge, not the top.
    const pct = ((rect.bottom - cy) / rect.height) * 100;
    layoutStore.setBottomPct(Math.max(15, Math.min(85, pct)));
  };

  return (
    <div class="h-full flex flex-col bg-[#FAFAF8] dark:bg-[#080D1B] text-ink-500 dark:text-ink-50">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <FilterBar />
      <FlowToolbar count={filtered().length} flows={filtered} onCompare={openCompare} />
      <FindAllBar />

      <div ref={sidebarSplitRef} class="flex-1 flex overflow-hidden min-h-0">
        <Show when={sidebarStore.open()}>
          <Sidebar />
          <Splitter
            orientation="vertical"
            containerRef={() => sidebarSplitRef}
            onDrag={(cx, _cy, rect) => sidebarStore.setWidth(cx - rect.left)}
          />
        </Show>
        <div class="flex-1 flex flex-col overflow-hidden min-w-0">

      <Show when={layoutStore.pos() === "right"}>
        <div ref={splitRef} class="flex-1 flex overflow-hidden">
          <div
            style={{ width: (selected() || composerOpen()) ? `${layoutStore.rightPct()}%` : "100%" }}
            class="overflow-hidden border-r border-ink-100 dark:border-ink-400/40"
          >
            <FlowList flows={filtered()} onCompare={openCompare} onOpen={(id) => { setComposerOpen(false); setOpenedFlowId(id); }} />
          </div>
          <Show when={selected() || composerOpen()}>
            <Splitter orientation="vertical" containerRef={() => splitRef} onDrag={onDragRight} />
            <div class="flex-1 overflow-hidden min-w-0">
              <Show when={composerOpen()} fallback={
                <Inspector flow={selected()} onClose={() => { setOpenedFlowId(null); flowsStore.clearSelection(); }} onComposer={openComposer} />
              }>
                <Composer onClose={() => setComposerOpen(false)} initialFlow={composerFlow()} />
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "bottom"}>
        <div ref={splitRef} class="flex-1 flex flex-col overflow-hidden">
          <div
            style={{ height: (selected() || composerOpen()) ? `${100 - layoutStore.bottomPct()}%` : "100%" }}
            class="overflow-hidden border-b border-ink-100 dark:border-ink-400/40"
          >
            <FlowList flows={filtered()} onCompare={openCompare} onOpen={(id) => { setComposerOpen(false); setOpenedFlowId(id); }} />
          </div>
          <Show when={selected() || composerOpen()}>
            <Splitter orientation="horizontal" containerRef={() => splitRef} onDrag={onDragBottom} />
            <div class="flex-1 overflow-hidden min-h-0">
              <Show when={composerOpen()} fallback={
                <Inspector flow={selected()} onClose={() => { setOpenedFlowId(null); flowsStore.clearSelection(); }} onComposer={openComposer} />
              }>
                <Composer onClose={() => setComposerOpen(false)} initialFlow={composerFlow()} />
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "hidden"}>
        <div class="flex-1 overflow-hidden">
          <FlowList flows={filtered()} onCompare={openCompare} onOpen={(id) => { setComposerOpen(false); setOpenedFlowId(id); }} />
        </div>
      </Show>

        </div>
      </div>

      <StatusBar />
      <Settings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <Show when={composerOpen() && layoutStore.pos() === "hidden"}>
        <div class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm grid place-items-center" onClick={() => setComposerOpen(false)}>
          <div class="w-[800px] max-w-[95vw] h-[600px] max-h-[90vh] rounded-2xl overflow-hidden border border-ink-100 dark:border-ink-400/40 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <Composer onClose={() => setComposerOpen(false)} initialFlow={composerFlow()} />
          </div>
        </div>
      </Show>
      <Show when={onboardingOpen()}>
        <Onboarding onClose={() => setOnboardingOpen(false)} />
      </Show>
      <Show when={compareOpen() && compareFlows()}>
        {(pair) => (
          <CompareView a={pair().a} b={pair().b} onClose={() => setCompareOpen(false)} />
        )}
      </Show>

    </div>
  );
}
