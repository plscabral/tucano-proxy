import { create } from "zustand";

const KEY = "tucano:sidebar";
type Persisted = { open: boolean; width: number };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function load(): Persisted {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "");
    return { open: s.open ?? true, width: clamp(s.width ?? 220, 160, 480) };
  } catch { return { open: true, width: 220 }; }
}

function persist(open: boolean, width: number) {
  localStorage.setItem(KEY, JSON.stringify({ open, width }));
}

function toggleIn(set: Set<string>, value: string, additive: boolean): Set<string> {
  const next = new Set(additive ? set : []);
  if (set.has(value) && additive) next.delete(value);
  else if (set.has(value) && set.size === 1) next.delete(value);
  else next.add(value);
  return next;
}

const init = load();

type SidebarState = {
  open: boolean;
  width: number;
  // Selection lives in memory only — like the FlowList selection — so it
  // resets between sessions and doesn't quietly hide flows on a fresh start.
  selectedApps: Set<string>;
  selectedDomains: Set<string>;
  selectedCategories: Set<string>;
  setOpen: (v: boolean) => void;
  toggleOpen: () => void;
  setWidth: (n: number) => void;
  toggleApp: (name: string, additive: boolean) => void;
  toggleDomain: (host: string, additive: boolean) => void;
  toggleCategory: (id: string, additive: boolean) => void;
  setCategories: (ids: Set<string>) => void;
  clear: () => void;
};

export const useSidebar = create<SidebarState>((set, get) => ({
  open: init.open,
  width: init.width,
  selectedApps: new Set<string>(),
  selectedDomains: new Set<string>(),
  selectedCategories: new Set<string>(),
  setOpen(v) { set({ open: v }); persist(v, get().width); },
  toggleOpen() { const v = !get().open; set({ open: v }); persist(v, get().width); },
  setWidth(n) { const w = clamp(n, 160, 480); set({ width: w }); persist(get().open, w); },
  toggleApp(name, additive) { set({ selectedApps: toggleIn(get().selectedApps, name, additive) }); },
  toggleDomain(host, additive) { set({ selectedDomains: toggleIn(get().selectedDomains, host, additive) }); },
  toggleCategory(id, additive) { set({ selectedCategories: toggleIn(get().selectedCategories, id, additive) }); },
  setCategories(ids) { set({ selectedCategories: ids }); },
  clear() {
    set({
      selectedApps: new Set<string>(),
      selectedDomains: new Set<string>(),
      selectedCategories: new Set<string>(),
    });
  },
}));
