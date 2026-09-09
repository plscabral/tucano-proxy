import { preferenceStorage } from "@/lib/platform";
import { create } from "zustand";
import type { ColId } from "./columns";

const KEY = "tucano:sort";

export type SortState = { by: ColId | null; dir: "asc" | "desc" };

function load(): SortState {
  try { return JSON.parse(preferenceStorage.getItem(KEY) || "") as SortState; }
  catch { return { by: null, dir: "asc" }; }
}

function persist(s: SortState) { preferenceStorage.setItem(KEY, JSON.stringify(s)); }

type SortStore = {
  by: ColId | null;
  dir: "asc" | "desc";
  toggle: (col: ColId) => void;
  clear: () => void;
};

export const useSort = create<SortStore>((set, get) => ({
  ...load(),
  toggle(col) {
    const { by, dir } = get();
    let next: SortState;
    if (by !== col) next = { by: col, dir: "asc" };
    else if (dir === "asc") next = { by: col, dir: "desc" };
    else next = { by: null, dir: "asc" };
    set(next); persist(next);
  },
  clear() { const next: SortState = { by: null, dir: "asc" }; set(next); persist(next); },
}));
