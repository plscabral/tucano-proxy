import { create } from "zustand";
import type { Flow, ProxyStatus } from "@/lib/types";

// id → index in the flows array. Kept in sync with every mutation so upsert
// is O(1) instead of O(n) findIndex on every Tauri flow:new / flow:update event.
// Module-level (not in store state) — it's a derived index, never rendered.
const _idx = new Map<string, number>();

// Throttle for `flowsView` — see `publishView`. Heavy consumers (FlowList
// filter pipeline, Sidebar groups, FlowToolbar count) read `flowsView` so they
// re-run at ~6 fps during active capture rather than once per batchUpsert.
// Shrinks (delete, clear, undo, trim) bypass the throttle (force = true).
let _viewTimer: number | null = null;
const VIEW_INTERVAL_MS = 180;

type FlowsState = {
  flows: Flow[];
  flowsView: Flow[];
  selectedIds: Set<string>;
  anchorId: string | null;
  status: ProxyStatus;

  setFlows: (next: Flow[]) => void;
  rebuildIndex: () => void;
  setStatus: (s: ProxyStatus) => void;

  selectedId: () => string | null;
  selectSingle: (id: string) => void;
  toggle: (id: string) => void;
  selectRange: (toId: string, ordered: Flow[]) => void;
  isSelected: (id: string) => boolean;
  getById: (id: string) => Flow | null;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;

  upsert: (f: Flow) => void;
  batchUpsert: (batch: Flow[]) => void;
  removeOneIfPresent: (id: string) => boolean;
  removeMany: (ids: Set<string>) => void;
  clear: () => void;
};

export const useFlows = create<FlowsState>((set, get) => {
  function publishView(next: Flow[], force: boolean) {
    const cur = get().flowsView;
    if (force || next.length < cur.length) {
      if (_viewTimer != null) { clearTimeout(_viewTimer); _viewTimer = null; }
      set({ flowsView: next });
      return;
    }
    if (_viewTimer != null) return;
    _viewTimer = window.setTimeout(() => {
      _viewTimer = null;
      set({ flowsView: get().flows });
    }, VIEW_INTERVAL_MS);
  }

  return {
    flows: [],
    flowsView: [],
    selectedIds: new Set<string>(),
    anchorId: null,
    status: { running: false, port: 8888, caInstalled: false, systemProxyOn: false, flowsCount: 0 },

    setFlows(next) {
      set({ flows: next });
      publishView(next, true);
    },
    rebuildIndex() {
      _idx.clear();
      get().flows.forEach((f, i) => _idx.set(f.id, i));
    },
    setStatus(s) { set({ status: s }); },

    selectedId() {
      const s = get().selectedIds;
      return s.size === 1 ? (s.values().next().value as string) : null;
    },
    selectSingle(id) { set({ selectedIds: new Set([id]), anchorId: id }); },
    toggle(id) {
      const next = new Set(get().selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      set({ selectedIds: next, anchorId: id });
    },
    selectRange(toId, ordered) {
      const a = get().anchorId;
      if (!a) { get().selectSingle(toId); return; }
      const ids = ordered.map((f) => f.id);
      const i = ids.indexOf(a);
      const j = ids.indexOf(toId);
      if (i < 0 || j < 0) { get().selectSingle(toId); return; }
      const [lo, hi] = i < j ? [i, j] : [j, i];
      set({ selectedIds: new Set(ids.slice(lo, hi + 1)) });
    },
    isSelected(id) { return get().selectedIds.has(id); },
    getById(id) {
      const i = _idx.get(id);
      return i === undefined ? null : get().flows[i] ?? null;
    },
    selectAll(ids) {
      // Preserve the previously inspected flow as the anchor — Cmd+A
      // shouldn't change which flow the inspector is showing.
      const cur = get().anchorId;
      set({
        selectedIds: new Set(ids),
        anchorId: !cur || !ids.includes(cur) ? ids[0] ?? null : cur,
      });
    },
    clearSelection() { set({ selectedIds: new Set<string>(), anchorId: null }); },

    upsert(f) {
      const prev = get().flows;
      let updated: Flow[];
      const idx = _idx.get(f.id);
      if (idx === undefined) {
        _idx.set(f.id, prev.length);
        updated = [...prev, f];
      } else {
        updated = prev.slice();
        updated[idx] = f;
      }
      set({ flows: updated });
      publishView(updated, false);
    },
    batchUpsert(batch) {
      if (batch.length === 0) return;
      const updated = get().flows.slice();
      for (const f of batch) {
        const idx = _idx.get(f.id);
        if (idx === undefined) {
          _idx.set(f.id, updated.length);
          updated.push(f);
        } else {
          updated[idx] = f;
        }
      }
      set({ flows: updated });
      publishView(updated, false);
    },
    // Fast path: drop a single id without touching selection state. Used by the
    // ignored-list pipeline, which would otherwise wipe selection on every
    // incoming ignored flow.
    removeOneIfPresent(id) {
      if (!_idx.has(id)) return false;
      const updated = get().flows.filter((f) => f.id !== id);
      _idx.clear();
      updated.forEach((f, i) => _idx.set(f.id, i));
      set({ flows: updated });
      publishView(updated, true);
      return true;
    },
    removeMany(ids) {
      const updated = get().flows.filter((f) => !ids.has(f.id));
      _idx.clear();
      updated.forEach((f, i) => _idx.set(f.id, i));
      set({ flows: updated, selectedIds: new Set<string>(), anchorId: null });
      publishView(updated, true);
    },
    clear() {
      _idx.clear();
      set({ flows: [], selectedIds: new Set<string>(), anchorId: null });
      publishView([], true);
    },
  };
});
