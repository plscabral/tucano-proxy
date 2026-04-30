import { createSignal } from "solid-js";

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

const [marks, setMarks] = createSignal<Record<string, string>>(load());

export const marksStore = {
  marks,
  get(id: string) { return marks()[id]; },
  set(id: string, colorId: string) {
    const next = { ...marks() };
    if (!colorId || colorId === "none") delete next[id];
    else next[id] = colorId;
    setMarks(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  },
  clear() { setMarks({}); localStorage.removeItem(KEY); },
};

export function colorOf(id: string | undefined): string | null {
  if (!id) return null;
  return MARK_COLORS.find((c) => c.id === id)?.color ?? null;
}
