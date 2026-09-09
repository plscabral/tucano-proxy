import { canMutate } from "@/lib/platform";
import { ipc } from "@/lib/ipc";
import type { Flow } from "@/lib/types";
import { create } from "zustand";


export const MARK_COLORS: { id: string; color: string }[] = [
  { id: "none",   color: "transparent" },
  { id: "red",    color: "#EF4444" },
  { id: "orange", color: "#F99245" },
  { id: "yellow", color: "#FACC15" },
  { id: "green",  color: "#10B981" },
  { id: "blue",   color: "#3B82F6" },
  { id: "purple", color: "#A855F7" },
];


type MarksState = {
  marks: Record<string, string>;
  get: (id: string) => string | undefined;
  set: (id: string, colorId: string) => void;
  clear: () => void;
  sync: (flows: Flow[], replace?: boolean) => void;
};

export const useMarks = create<MarksState>((set, get) => ({
  marks: {},
  get(id) { return get().marks[id]; },
  set(id, colorId) {
    if (!canMutate()) return;
    const mark = !colorId || colorId === "none" ? null : colorId;
    void ipc.updateFlowMark(id, mark).then(() => {
      const next = { ...get().marks };
      if (mark) next[id] = mark; else delete next[id];
      set({ marks: next });
    }).catch((error) => alert(String(error)));
  },
  clear() { set({ marks: {} }); },
  sync(flows, replace = false) {
    const current = get().marks;
    let next: Record<string, string> | null = replace ? {} : null;
    for (const flow of flows) {
      const mark = flow.mark || undefined;
      if (!replace && current[flow.id] === mark) continue;
      next ??= { ...current };
      if (mark) next[flow.id] = mark;
      else delete next[flow.id];
    }
    if (next) set({ marks: next });
  },
}));

export function colorOf(id: string | undefined): string | null {
  if (!id) return null;
  return MARK_COLORS.find((c) => c.id === id)?.color ?? null;
}
