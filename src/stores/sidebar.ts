import { createSignal, createEffect } from "solid-js";

const KEY = "tucano:sidebar";
type Persisted = { open: boolean; width: number };

function load(): Persisted {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "");
    return { open: s.open ?? true, width: clamp(s.width ?? 220, 160, 480) };
  } catch { return { open: true, width: 220 }; }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const init = load();
const [open, setOpen] = createSignal(init.open);
const [width, setWidthSignal] = createSignal(init.width);
// Selection lives in memory only — like the FlowList selection — so it
// resets between sessions and doesn't quietly hide flows on a fresh start.
const [selectedApps, setSelectedApps] = createSignal<Set<string>>(new Set());
const [selectedDomains, setSelectedDomains] = createSignal<Set<string>>(new Set());
const [selectedCategories, setSelectedCategories] = createSignal<Set<string>>(new Set());

createEffect(() => {
  localStorage.setItem(KEY, JSON.stringify({ open: open(), width: width() }));
});

function toggleIn(set: Set<string>, value: string, additive: boolean): Set<string> {
  const next = new Set(additive ? set : []);
  if (set.has(value) && additive) next.delete(value);
  else if (set.has(value) && set.size === 1) next.delete(value);
  else next.add(value);
  return next;
}

export const sidebarStore = {
  open, setOpen,
  toggleOpen: () => setOpen(!open()),
  width,
  setWidth: (n: number) => setWidthSignal(clamp(n, 160, 480)),
  selectedApps,
  selectedDomains,
  selectedCategories,
  toggleApp(name: string, additive: boolean) {
    setSelectedApps((s) => toggleIn(s, name, additive));
  },
  toggleDomain(host: string, additive: boolean) {
    setSelectedDomains((s) => toggleIn(s, host, additive));
  },
  toggleCategory(id: string, additive: boolean) {
    setSelectedCategories((s) => toggleIn(s, id, additive));
  },
  setCategories(ids: Set<string>) {
    setSelectedCategories(ids);
  },
  clear() {
    setSelectedApps(new Set<string>());
    setSelectedDomains(new Set<string>());
    setSelectedCategories(new Set<string>());
  },
};
