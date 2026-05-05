import { diffLines, type Change } from "diff";
import { beautifyJson } from "./format";

export type HeaderDiffStatus = "same" | "onlyA" | "onlyB" | "changed";
export type HeaderDiffRow = {
  key: string;
  status: HeaderDiffStatus;
  a: string | null;
  b: string | null;
};

export function diffHeaders(a: [string, string][], b: [string, string][]): HeaderDiffRow[] {
  const norm = (h: [string, string][]) => {
    const m = new Map<string, { display: string; value: string }>();
    for (const [k, v] of h) {
      const key = k.toLowerCase();
      if (!m.has(key)) m.set(key, { display: k, value: v });
    }
    return m;
  };
  const ma = norm(a);
  const mb = norm(b);
  const keys = new Set<string>([...ma.keys(), ...mb.keys()]);
  const rows: HeaderDiffRow[] = [];
  for (const k of keys) {
    const ea = ma.get(k);
    const eb = mb.get(k);
    if (ea && eb) {
      rows.push({
        key: ea.display,
        status: ea.value === eb.value ? "same" : "changed",
        a: ea.value,
        b: eb.value,
      });
    } else if (ea) {
      rows.push({ key: ea.display, status: "onlyA", a: ea.value, b: null });
    } else if (eb) {
      rows.push({ key: eb.display, status: "onlyB", a: null, b: eb.value });
    }
  }
  rows.sort((x, y) => x.key.toLowerCase().localeCompare(y.key.toLowerCase()));
  return rows;
}

export type BodyDiffPart = Change;

export function diffBody(
  a: string | null,
  b: string | null,
  contentType: string | null,
): BodyDiffPart[] {
  const isJson = !!contentType && contentType.includes("json");
  const norm = (s: string | null) => {
    if (s == null || s === "") return "";
    if (!isJson) return s;
    try { return beautifyJson(s); } catch { return s; }
  };
  const A = norm(a);
  const B = norm(b);
  return diffLines(A, B, { newlineIsToken: false });
}
