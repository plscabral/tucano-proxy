import { createStore, produce } from "solid-js/store";
import type { Rule } from "../lib/rules";

const KEY = "tucano:rules";

function load(): Rule[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

const [state, setState] = createStore<{ list: Rule[] }>({ list: load() });

function persist() { localStorage.setItem(KEY, JSON.stringify(state.list)); }

export const rulesStore = {
  rules: () => state.list,
  set(r: Rule[]) { setState("list", r); persist(); },
  add(r: Rule) { setState("list", state.list.length, r); persist(); },
  remove(id: string) {
    setState("list", (l) => l.filter((x) => x.id !== id));
    persist();
  },
  update(id: string, patch: Partial<Rule>) {
    setState(produce((s) => {
      const r = s.list.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    }));
    persist();
  },
  clear() { setState("list", []); persist(); },
};
