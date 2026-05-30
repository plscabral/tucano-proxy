import { create } from "zustand";
import type { Rule } from "@/lib/rules";

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

function persist(list: Rule[]) { localStorage.setItem(KEY, JSON.stringify(list)); }

type RulesState = {
  list: Rule[];
  captureMode: boolean;
  matchMode: MatchMode;
  set: (r: Rule[]) => void;
  add: (r: Rule) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Rule>) => void;
  clear: () => void;
  setCaptureMode: (on: boolean) => void;
  setMatchMode: (m: MatchMode) => void;
};

export const useRules = create<RulesState>((set, get) => ({
  list: load(),
  captureMode: loadCapture(),
  matchMode: (localStorage.getItem(KEY_MATCH) as MatchMode) === "any" ? "any" : "all",
  set(r) { set({ list: r }); persist(r); },
  add(r) { const list = [...get().list, r]; set({ list }); persist(list); },
  remove(id) { const list = get().list.filter((x) => x.id !== id); set({ list }); persist(list); },
  update(id, patch) {
    const list = get().list.map((x) => (x.id === id ? { ...x, ...patch } : x));
    set({ list }); persist(list);
  },
  clear() { set({ list: [] }); persist([]); },
  setCaptureMode(on) {
    set({ captureMode: on });
    localStorage.setItem(KEY_CAPTURE, on ? "1" : "0");
  },
  setMatchMode(m) {
    set({ matchMode: m });
    localStorage.setItem(KEY_MATCH, m);
  },
}));
