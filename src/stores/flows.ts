import { createSignal } from "solid-js";
import type { Flow, ProxyStatus } from "../lib/types";

const [flows, setFlows] = createSignal<Flow[]>([]);
// Throttled mirror of `flows`. Heavy consumers (FlowList filter pipeline,
// Sidebar groups, FlowToolbar count) read this one instead of the raw signal
// so they re-run at ~6 fps during active capture rather than once per
// batchUpsert. Shrinks (delete, clear, undo, trim) bypass the throttle —
// see `_publishView` below.
const [flowsView, setFlowsView] = createSignal<Flow[]>([]);
let _viewTimer: number | null = null;
const VIEW_INTERVAL_MS = 180;
function _publishView(next: Flow[], force: boolean) {
  const cur = flowsView();
  if (force || next.length < cur.length) {
    if (_viewTimer != null) { clearTimeout(_viewTimer); _viewTimer = null; }
    setFlowsView(next);
    return;
  }
  if (_viewTimer != null) return;
  _viewTimer = window.setTimeout(() => {
    _viewTimer = null;
    setFlowsView(flows());
  }, VIEW_INTERVAL_MS);
}

const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
const [anchorId, setAnchorId] = createSignal<string | null>(null);
const [filter, setFilter] = createSignal("");
const [category, setCategory] = createSignal<string>("all");
const [status, setStatus] = createSignal<ProxyStatus>({
  running: false, port: 8888, caInstalled: false, systemProxyOn: false, flowsCount: 0,
});

// id → index in the flows array. Kept in sync with every mutation so upsert
// is O(1) instead of O(n) findIndex on every Tauri flow:new / flow:update event.
const _idx = new Map<string, number>();

export const flowsStore = {
  flows,
  flowsView,
  setFlows(next: Flow[]) {
    setFlows(next);
    _publishView(next, true);
  },
  selectedIds,
  anchorId,
  filter, setFilter,
  category, setCategory,
  status, setStatus,

  selectedId(): string | null {
    const s = selectedIds();
    return s.size === 1 ? s.values().next().value as string : null;
  },
  selectSingle(id: string) {
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  },
  toggle(id: string) {
    const next = new Set(selectedIds());
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setAnchorId(id);
  },
  selectRange(toId: string, ordered: Flow[]) {
    const a = anchorId();
    if (!a) { return this.selectSingle(toId); }
    const ids = ordered.map((f) => f.id);
    const i = ids.indexOf(a);
    const j = ids.indexOf(toId);
    if (i < 0 || j < 0) { return this.selectSingle(toId); }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    setSelectedIds(new Set(ids.slice(lo, hi + 1)));
  },
  isSelected(id: string) { return selectedIds().has(id); },
  getById(id: string): Flow | null {
    const i = _idx.get(id);
    return i === undefined ? null : flows()[i] ?? null;
  },
  selectAll(ids: string[]) {
    setSelectedIds(new Set(ids));
    // Preserve the previously inspected flow as the anchor — Cmd+A
    // shouldn't change which flow the inspector is showing.
    const cur = anchorId();
    if (!cur || !ids.includes(cur)) setAnchorId(ids[0] ?? null);
  },
  clearSelection() { setSelectedIds(new Set<string>()); setAnchorId(null); },

  upsert(f: Flow) {
    let updated!: Flow[];
    setFlows((prev) => {
      const idx = _idx.get(f.id);
      if (idx === undefined) {
        _idx.set(f.id, prev.length);
        updated = [...prev, f];
      } else {
        updated = prev.slice();
        updated[idx] = f;
      }
      return updated;
    });
    _publishView(updated, false);
  },
  batchUpsert(batch: Flow[]) {
    if (batch.length === 0) return;
    let updated!: Flow[];
    setFlows((prev) => {
      updated = prev.slice();
      for (const f of batch) {
        const idx = _idx.get(f.id);
        if (idx === undefined) {
          _idx.set(f.id, updated.length);
          updated.push(f);
        } else {
          updated[idx] = f;
        }
      }
      return updated;
    });
    _publishView(updated, false);
  },
  // Fast path: drop a single id without touching selection state. Used by the
  // ignored-list pipeline, which would otherwise wipe selection on every
  // incoming ignored flow (and pay a full setFlows + publishView each time).
  removeOneIfPresent(id: string): boolean {
    if (!_idx.has(id)) return false;
    let updated!: Flow[];
    setFlows((prev) => {
      updated = prev.filter((f) => f.id !== id);
      _idx.clear();
      updated.forEach((f, i) => _idx.set(f.id, i));
      return updated;
    });
    _publishView(updated, true);
    return true;
  },
  removeMany(ids: Set<string>) {
    let updated!: Flow[];
    setFlows((prev) => {
      updated = prev.filter((f) => !ids.has(f.id));
      // Rebuild index after removal since positions shift.
      _idx.clear();
      updated.forEach((f, i) => _idx.set(f.id, i));
      return updated;
    });
    _publishView(updated, true);
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  },
  clear() {
    _idx.clear();
    setFlows([]);
    _publishView([], true);
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  },
  // Called after a bulk setFlows (e.g. ipc.listFlows on mount/open session)
  // so the index reflects the new array.
  rebuildIndex() {
    _idx.clear();
    flows().forEach((f, i) => _idx.set(f.id, i));
  },
};
