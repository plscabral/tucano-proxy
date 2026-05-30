import { create } from "zustand";

const KEY = "tucano:marks";

export const MARK_COLORS: { id: string; color: string }[] = [
  { id: "none",   color: "transparent" },
  { id: "red",    color: "#EF4444" },
  { id: "orange", color: "#F99245" },
  { id: "yellow", color: "#FACC15" },
  { id: "green",  color: "#10B981" },
  { id: "blue",   color: "#3B82F6" },
  { id: "purple", color: "#A855F7" },
];

function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

type MarksState = {
  marks: Record<string, string>;
  get: (id: string) => string | undefined;
  set: (id: string, colorId: string) => void;
  clear: () => void;
};

export const useMarks = create<MarksState>((set, get) => ({
  marks: load(),
  get(id) { return get().marks[id]; },
  set(id, colorId) {
    const next = { ...get().marks };
    if (!colorId || colorId === "none") delete next[id];
    else next[id] = colorId;
    set({ marks: next });
    localStorage.setItem(KEY, JSON.stringify(next));
  },
  clear() { set({ marks: {} }); localStorage.removeItem(KEY); },
}));

export function colorOf(id: string | undefined): string | null {
  if (!id) return null;
  return MARK_COLORS.find((c) => c.id === id)?.color ?? null;
}
