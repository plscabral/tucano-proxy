import { create } from "zustand";
import { useFlows } from "./flows";

// Global "find in all captures" search. `matches` is a Set recomputed when the
// query/case-sensitivity changes, and (while a query is active) whenever the
// flow list changes so streaming captures stay in sync. Rows read membership
// via `useFindAll(s => s.matches.has(id))`.
function compute(query: string, caseSensitive: boolean): Set<string> {
  if (!query) return new Set();
  const cs = caseSensitive;
  const needle = cs ? query : query.toLowerCase();
  const hit = (s: string | null | undefined) => {
    if (!s) return false;
    return (cs ? s : s.toLowerCase()).includes(needle);
  };
  const out = new Set<string>();
  for (const f of useFlows.getState().flows) {
    const url = `${f.scheme}://${f.host}${f.path}`;
    // Search only fields that identify the capture itself: URL parts,
    // method/status, the user's note, and the bodies. Headers are skipped
    // because Referer/Origin/Cookie/etc. leak URL context across unrelated
    // requests.
    if (
      hit(url) || hit(f.method) || hit(f.note ?? "") ||
      hit(String(f.status ?? "")) || hit(f.host) || hit(f.path) ||
      (f.reqBodyEncoding === "utf8" && hit(f.reqBody)) ||
      (f.resBodyEncoding === "utf8" && hit(f.resBody))
    ) {
      out.add(f.id);
    }
  }
  return out;
}

type FindAllState = {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matches: Set<string>;
  setOpen: (v: boolean) => void;
  setQuery: (q: string) => void;
  setCaseSensitive: (v: boolean) => void;
  close: () => void;
  toggle: () => void;
  isMatch: (id: string) => boolean;
  active: () => boolean;
  recompute: () => void;
};

export const useFindAll = create<FindAllState>((set, get) => ({
  open: false,
  query: "",
  caseSensitive: false,
  matches: new Set<string>(),
  setOpen(v) { set({ open: v }); },
  setQuery(q) { set({ query: q, matches: compute(q, get().caseSensitive) }); },
  setCaseSensitive(v) { set({ caseSensitive: v, matches: compute(get().query, v) }); },
  close() { set({ open: false }); },
  toggle() { set({ open: !get().open }); },
  isMatch(id) { return get().matches.has(id); },
  active() { return get().open && get().query.length > 0; },
  recompute() { set({ matches: compute(get().query, get().caseSensitive) }); },
}));

// Keep matches fresh as captures stream in — only while a query is active.
useFlows.subscribe((s, p) => {
  if (s.flows !== p.flows && useFindAll.getState().query) {
    useFindAll.getState().recompute();
  }
});
