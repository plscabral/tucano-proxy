import { createStore, produce } from "solid-js/store";
import { createSignal } from "solid-js";
import type { Rule } from "../lib/rules";

const KEY = "tucano:rules";
const KEY_CAPTURE = "tucano:rules:captureMode";
const KEY_MATCH = "tucano:rules:matchMode";

export type MatchMode = "all" | "any";

function load(): Rule[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

function loadCapture(): boolean {
  return localStorage.getItem(KEY_CAPTURE) === "1";
}

const [state, setState] = createStore<{ list: Rule[] }>({ list: load() });
const [captureMode, setCaptureModeSignal] = createSignal<boolean>(loadCapture());
const [matchMode, setMatchModeSignal] = createSignal<MatchMode>(
  (localStorage.getItem(KEY_MATCH) as MatchMode) === "any" ? "any" : "all",
);

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

  captureMode,
  setCaptureMode(on: boolean) {
    setCaptureModeSignal(on);
    localStorage.setItem(KEY_CAPTURE, on ? "1" : "0");
  },

  matchMode,
  setMatchMode(m: MatchMode) {
    setMatchModeSignal(m);
    localStorage.setItem(KEY_MATCH, m);
  },
};
