import { createMemo, createSignal } from "solid-js";
import { flowsStore } from "./flows";

const [open, setOpen] = createSignal(false);
const [query, setQuery] = createSignal("");
const [caseSensitive, setCaseSensitive] = createSignal(false);

const matches = createMemo<Set<string>>(() => {
  const q = query();
  if (!q) return new Set();
  const cs = caseSensitive();
  const needle = cs ? q : q.toLowerCase();
  const hit = (s: string | null | undefined) => {
    if (!s) return false;
    return (cs ? s : s.toLowerCase()).includes(needle);
  };
  const out = new Set<string>();
  for (const f of flowsStore.flows()) {
    const url = `${f.scheme}://${f.host}${f.path}`;
    // Search only fields that identify the capture itself: URL parts,
    // method/status, the user's note, and the bodies. Headers are skipped
    // because Referer/Origin/Cookie/etc. leak URL context across unrelated
    // requests (a favicon hit would match a "login" search just because
    // the page that triggered it had "login" in its Referer).
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
});

export const findAllStore = {
  open, query, caseSensitive, matches,
  setOpen, setQuery, setCaseSensitive,
  isMatch(id: string) { return matches().has(id); },
  active() { return open() && query().length > 0; },
  close() { setOpen(false); },
  toggle() { setOpen(!open()); },
};
