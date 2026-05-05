import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import FlowList from "./components/FlowList";
import Inspector from "./components/Inspector";
import FilterBar from "./components/FilterBar";
import CategoryTabs from "./components/CategoryTabs";
import FlowToolbar from "./components/FlowToolbar";
import Settings from "./components/Settings";
import Splitter from "./components/Splitter";
import Onboarding, { shouldShowOnboarding } from "./components/Onboarding";
import CompareView from "./components/CompareView";
import { flowsStore } from "./stores/flows";
import { marksStore, MARK_COLORS } from "./stores/marks";
import { ipc, onFlowNew, onFlowUpdate } from "./lib/ipc";
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

  onMount(async () => {
    try {
      flowsStore.setStatus(await ipc.status());
      flowsStore.setFlows(await ipc.listFlows());
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

  const unNew = onFlowNew((f) => flowsStore.upsert(f));
  const unUp = onFlowUpdate((f) => flowsStore.upsert(f));

  const onKey = async (e: KeyboardEvent) => {
    // When a modal is open, keep all keystrokes scoped to the dialog —
    // global shortcuts (Cmd+A, Space, etc.) must not leak through to the
    // background flow list.
    if (noteStore.openId() || onboardingOpen()) return;
    if (settingsOpen()) {
      if (e.key === "Escape") setSettingsOpen(false);
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
      if (p && typeof p === "string") { await ipc.openSession(p); flowsStore.setFlows(await ipc.listFlows()); }
    } else if (e.key === "Escape") {
      if (settingsOpen()) setSettingsOpen(false);
    } else if (!inField && e.key === " ") {
      e.preventDefault();
      const s = flowsStore.status();
      if (s.running) await ipc.stopCapture(); else await ipc.startCapture(s.port);
      flowsStore.setStatus(await ipc.status());
    } else if (!inField && (e.key === "Delete" || e.key === "Backspace")) {
      const ids = flowsStore.selectedIds();
      if (ids.size > 0) {
        e.preventDefault();
        const arr = Array.from(ids);
        const snapshot = flowsStore.flows().filter((f) => ids.has(f.id));
        await ipc.deleteFlows(arr);
        flowsStore.removeMany(ids);
        undoStore.push(snapshot);
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
      const idx = parseInt(e.key, 10) - 1;
      if (CATEGORIES[idx]) flowsStore.setCategory(CATEGORIES[idx].id);
    }
  };
  window.addEventListener("keydown", onKey);

  onCleanup(async () => {
    window.removeEventListener("keydown", onKey);
    (await unNew)(); (await unUp)();
  });

  const filtered = createMemo(() => {
    const cat = flowsStore.category() as Category;
    const byCat = flowsStore.flows().filter((f) => matchesCategory(f, cat));
    const byRules = applyRules(byCat, rulesStore.rules());
    const s = sortStore.state();
    return sortFlows(byRules, s.by, s.dir);
  });
  const selected = createMemo(() => {
    // Inspector follows the anchor (last-clicked) flow so multi-select
    // (Cmd+A, Shift-click) doesn't close the detail pane. Falls back to
    // the single-selected id when no anchor is set.
    const sel = flowsStore.selectedIds();
    const anchor = flowsStore.anchorId();
    const id = anchor && sel.has(anchor) ? anchor : flowsStore.selectedId();
    return id ? flowsStore.flows().find((f) => f.id === id) ?? null : null;
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
    <div class="h-full flex flex-col bg-white dark:bg-ink-500 text-ink-500 dark:text-ink-50">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <CategoryTabs />
      <FilterBar />
      <FlowToolbar count={filtered().length} flows={filtered} onCompare={openCompare} />

      <Show when={layoutStore.pos() === "right"}>
        <div ref={splitRef} class="flex-1 flex overflow-hidden">
          <div
            style={{ width: selected() ? `${layoutStore.rightPct()}%` : "100%" }}
            class="overflow-hidden border-r border-ink-100 dark:border-ink-400/40"
          >
            <FlowList flows={filtered()} onCompare={openCompare} />
          </div>
          <Show when={selected()}>
            <Splitter orientation="vertical" containerRef={() => splitRef} onDrag={onDragRight} />
            <div class="flex-1 overflow-hidden min-w-0">
              <Inspector flow={selected()} onClose={() => flowsStore.clearSelection()} />
            </div>
          </Show>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "bottom"}>
        <div ref={splitRef} class="flex-1 flex flex-col overflow-hidden">
          <div
            style={{ height: selected() ? `${100 - layoutStore.bottomPct()}%` : "100%" }}
            class="overflow-hidden border-b border-ink-100 dark:border-ink-400/40"
          >
            <FlowList flows={filtered()} onCompare={openCompare} />
          </div>
          <Show when={selected()}>
            <Splitter orientation="horizontal" containerRef={() => splitRef} onDrag={onDragBottom} />
            <div class="flex-1 overflow-hidden min-h-0">
              <Inspector flow={selected()} onClose={() => flowsStore.clearSelection()} />
            </div>
          </Show>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "hidden"}>
        <div class="flex-1 overflow-hidden">
          <FlowList flows={filtered()} onCompare={openCompare} />
        </div>
      </Show>

      <StatusBar />
      <Settings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
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
