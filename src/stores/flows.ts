import { createSignal } from "solid-js";
import type { Flow, ProxyStatus } from "../lib/types";

const [flows, setFlows] = createSignal<Flow[]>([]);
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
  flows, setFlows,
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
  selectAll(ids: string[]) {
    setSelectedIds(new Set(ids));
    // Preserve the previously inspected flow as the anchor — Cmd+A
    // shouldn't change which flow the inspector is showing.
    const cur = anchorId();
    if (!cur || !ids.includes(cur)) setAnchorId(ids[0] ?? null);
  },
  clearSelection() { setSelectedIds(new Set<string>()); setAnchorId(null); },

  upsert(f: Flow) {
    setFlows((prev) => {
      const idx = _idx.get(f.id);
      if (idx === undefined) {
        _idx.set(f.id, prev.length);
        return [...prev, f];
      }
      const next = prev.slice();
      next[idx] = f;
      return next;
    });
  },
  batchUpsert(batch: Flow[]) {
    if (batch.length === 0) return;
    setFlows((prev) => {
      const next = prev.slice();
      for (const f of batch) {
        const idx = _idx.get(f.id);
        if (idx === undefined) {
          _idx.set(f.id, next.length);
          next.push(f);
        } else {
          next[idx] = f;
        }
      }
      return next;
    });
  },
  removeMany(ids: Set<string>) {
    setFlows((prev) => {
      const next = prev.filter((f) => !ids.has(f.id));
      // Rebuild index after removal since positions shift.
      _idx.clear();
      next.forEach((f, i) => _idx.set(f.id, i));
      return next;
    });
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  },
  clear() {
    _idx.clear();
    setFlows([]);
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
