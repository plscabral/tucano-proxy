import { createSignal } from "solid-js";
import type { Flow } from "../lib/types";
import { ipc } from "../lib/ipc";
import { flowsStore } from "./flows";
import { marksStore } from "./marks";

type UndoEntry = {
  flows: Flow[];
  marks: Record<string, string>;
};

const MAX_STACK = 20;
const [stack, setStack] = createSignal<UndoEntry[]>([]);

function captureMarks(ids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const m = marksStore.get(id);
    if (m) out[id] = m;
  }
  return out;
}

export const undoStore = {
  canUndo: () => stack().length > 0,
  push(flows: Flow[]) {
    if (flows.length === 0) return;
    const marks = captureMarks(flows.map((f) => f.id));
    setStack((prev) => {
      const next = [...prev, { flows, marks }];
      if (next.length > MAX_STACK) next.shift();
      return next;
    });
  },
  async undo() {
    const top = stack()[stack().length - 1];
    if (!top) return false;
    setStack((prev) => prev.slice(0, -1));
    try {
      await ipc.restoreFlows(top.flows);
    } catch (e) {
      console.error("restore_flows failed", e);
      return false;
    }
    for (const f of top.flows) flowsStore.upsert(f);
    for (const [id, color] of Object.entries(top.marks)) marksStore.set(id, color);
    return true;
  },
  clear() { setStack([]); },
};
