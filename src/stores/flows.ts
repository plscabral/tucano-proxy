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
    setAnchorId(ids[0] ?? null);
  },
  clearSelection() { setSelectedIds(new Set<string>()); setAnchorId(null); },

  upsert(f: Flow) {
    setFlows((prev) => {
      const idx = prev.findIndex((x) => x.id === f.id);
      if (idx === -1) return [...prev, f];
      const next = prev.slice();
      next[idx] = f;
      return next;
    });
  },
  removeMany(ids: Set<string>) {
    setFlows((prev) => prev.filter((f) => !ids.has(f.id)));
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  },
  clear() { setFlows([]); setSelectedIds(new Set<string>()); setAnchorId(null); },
};
