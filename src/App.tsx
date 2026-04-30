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
import { flowsStore } from "./stores/flows";
import { marksStore, MARK_COLORS } from "./stores/marks";
import { ipc, onFlowNew, onFlowUpdate } from "./lib/ipc";
import { applyRules } from "./lib/rules";
import { rulesStore } from "./stores/rules";
import { matchesCategory, CATEGORIES, type Category } from "./lib/category";
import { layoutStore } from "./stores/layout";
import { sortStore } from "./stores/sort";
import { sortFlows } from "./lib/sortFlows";

export default function App() {
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [onboardingOpen, setOnboardingOpen] = createSignal(shouldShowOnboarding());
  let splitRef!: HTMLDivElement;

  onMount(async () => {
    try {
      flowsStore.setStatus(await ipc.status());
      flowsStore.setFlows(await ipc.listFlows());
    } catch (e) { console.warn("ipc unavailable?", e); }
  });

  const unNew = onFlowNew((f) => flowsStore.upsert(f));
  const unUp = onFlowUpdate((f) => flowsStore.upsert(f));

  const onKey = async (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    const tag = (e.target as HTMLElement)?.tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA";

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
      setTimeout(() => (document.querySelector('input[placeholder]') as HTMLInputElement)?.focus(), 0);
    } else if (meta && e.key === ",") {
      e.preventDefault(); setSettingsOpen(true);
    } else if (meta && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (confirm("Clear all flows?")) { await ipc.clearFlows(); flowsStore.clear(); marksStore.clear(); }
    } else if (meta && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const { save } = await import("@tauri-apps/plugin-dialog");
      const p = await save({ defaultPath: "session.tucano", filters: [{ name: "Tucano", extensions: ["tucano"] }] });
      if (p) await ipc.saveSession(p);
    } else if (meta && e.key.toLowerCase() === "o") {
      e.preventDefault();
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ multiple: false, filters: [{ name: "Tucano", extensions: ["tucano"] }] });
      if (p && typeof p === "string") { await ipc.openSession(p); flowsStore.setFlows(await ipc.listFlows()); }
    } else if (e.key === "Escape") {
      if (settingsOpen()) setSettingsOpen(false);
      else rulesStore.clear();
    } else if (!inField && e.key === " ") {
      e.preventDefault();
      const s = flowsStore.status();
      if (s.running) await ipc.stopProxy(); else await ipc.startProxy(s.port);
      flowsStore.setStatus(await ipc.status());
    } else if (!inField && (e.key === "Delete" || e.key === "Backspace")) {
      const ids = flowsStore.selectedIds();
      if (ids.size > 0) {
        e.preventDefault();
        const arr = Array.from(ids);
        await ipc.deleteFlows(arr);
        flowsStore.removeMany(ids);
      }
    } else if (meta && /^[0-6]$/.test(e.key)) {
      // Cmd/Ctrl + 0..6 → mark selected flows with the matching color
      const ids = flowsStore.selectedIds();
      if (ids.size > 0) {
        e.preventDefault();
        const colorId = MARK_COLORS[parseInt(e.key, 10)]?.id;
        if (colorId) ids.forEach((id) => marksStore.set(id, colorId));
      }
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
    const id = flowsStore.selectedId();
    return id ? flowsStore.flows().find((f) => f.id === id) ?? null : null;
  });

  const onDragRight = (cx: number, _cy: number, rect: DOMRect) => {
    const pct = ((cx - rect.left) / rect.width) * 100;
    layoutStore.setRightPct(pct);
  };
  const onDragBottom = (_cx: number, cy: number, rect: DOMRect) => {
    const pct = ((cy - rect.top) / rect.height) * 100;
    layoutStore.setBottomPct(pct);
  };

  return (
    <div class="h-full flex flex-col bg-white dark:bg-ink-500 text-ink-500 dark:text-ink-50">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <CategoryTabs />
      <FilterBar />
      <FlowToolbar count={filtered().length} />

      <Show when={layoutStore.pos() === "right"}>
        <div ref={splitRef} class="flex-1 flex overflow-hidden">
          <div style={{ width: `${layoutStore.rightPct()}%` }} class="overflow-hidden border-r border-ink-100 dark:border-ink-400/40">
            <FlowList flows={filtered()} />
          </div>
          <Splitter orientation="vertical" containerRef={() => splitRef} onDrag={onDragRight} />
          <div class="flex-1 overflow-hidden min-w-0">
            <Inspector flow={selected()} />
          </div>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "bottom"}>
        <div ref={splitRef} class="flex-1 flex flex-col overflow-hidden">
          <div style={{ height: `${100 - layoutStore.bottomPct()}%` }} class="overflow-hidden border-b border-ink-100 dark:border-ink-400/40">
            <FlowList flows={filtered()} />
          </div>
          <Splitter orientation="horizontal" containerRef={() => splitRef} onDrag={onDragBottom} />
          <div class="flex-1 overflow-hidden min-h-0">
            <Inspector flow={selected()} />
          </div>
        </div>
      </Show>

      <Show when={layoutStore.pos() === "hidden"}>
        <div class="flex-1 overflow-hidden">
          <FlowList flows={filtered()} />
        </div>
      </Show>

      <StatusBar />
      <Settings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <Show when={onboardingOpen()}>
        <Onboarding onClose={() => setOnboardingOpen(false)} />
      </Show>
    </div>
  );
}
