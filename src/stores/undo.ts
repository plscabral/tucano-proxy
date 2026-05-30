import { create } from "zustand";
import type { Flow } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { useFlows } from "./flows";
import { useMarks } from "./marks";

type UndoEntry = {
  flows: Flow[];
  marks: Record<string, string>;
};

const MAX_STACK = 20;

function captureMarks(ids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const marks = useMarks.getState();
  for (const id of ids) {
    const m = marks.get(id);
    if (m) out[id] = m;
  }
  return out;
}

type UndoState = {
  stack: UndoEntry[];
  canUndo: () => boolean;
  push: (flows: Flow[]) => void;
  undo: () => Promise<boolean>;
  clear: () => void;
};

export const useUndo = create<UndoState>((set, get) => ({
  stack: [],
  canUndo: () => get().stack.length > 0,
  push(flows) {
    if (flows.length === 0) return;
    const marks = captureMarks(flows.map((f) => f.id));
    const next = [...get().stack, { flows, marks }];
    if (next.length > MAX_STACK) next.shift();
    set({ stack: next });
  },
  async undo() {
    const stack = get().stack;
    const top = stack[stack.length - 1];
    if (!top) return false;
    set({ stack: stack.slice(0, -1) });
    try {
      await ipc.restoreFlows(top.flows);
    } catch (e) {
      console.error("restore_flows failed", e);
      return false;
    }
    const flowsStore = useFlows.getState();
    const marksStore = useMarks.getState();
    for (const f of top.flows) flowsStore.upsert(f);
    for (const [id, color] of Object.entries(top.marks)) marksStore.set(id, color);
    return true;
  },
  clear() { set({ stack: [] }); },
}));
