import type { Flow } from "./types";

type Token = { key: string; op: string; value: string; negate: boolean };

const KEYS = new Set([
  "host", "method", "path", "status", "scheme", "size",
  "mime", "type", "header", "body", "duration", "ext", "port", "proto",
]);

export function parseQuery(q: string): { tokens: Token[]; freeText: string } {
  const tokens: Token[] = [];
  const free: string[] = [];
  // matches: -key:val | key:val | key:>=val | key:"quoted text"
  const re = /(-?)(\w+):([<>]=?|=)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(q))) {
    const before = q.slice(last, m.index).trim();
    if (before) free.push(before);
    const key = m[2].toLowerCase();
    if (!KEYS.has(key)) { last = re.lastIndex; free.push(m[0]); continue; }
    tokens.push({
      negate: m[1] === "-",
      key,
      op: m[3] || "=",
      value: m[4] ?? m[5] ?? "",
    });
    last = re.lastIndex;
  }
  const tail = q.slice(last).trim();
  if (tail) free.push(tail);
  return { tokens, freeText: free.join(" ").toLowerCase() };
}

function cmpNum(op: string, a: number, b: number) {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return a === b;
  }
}

function matchToken(f: Flow, t: Token): boolean {
  const v = t.value.toLowerCase();
  switch (t.key) {
    case "host": return f.host.toLowerCase().includes(v);
    case "method": return f.method.toLowerCase() === v;
    case "path": return f.path.toLowerCase().includes(v);
    case "scheme":
    case "proto": return f.scheme.toLowerCase() === v;
    case "ext": return f.path.toLowerCase().split("?")[0].endsWith("." + v.replace(/^\./, ""));
    case "port": {
      const n = Number(t.value);
      return !Number.isNaN(n) && cmpNum(t.op, f.port, n);
    }
    case "status": {
      if (v === "ok") return f.status != null && f.status >= 200 && f.status < 300;
      if (v === "redirect") return f.status != null && f.status >= 300 && f.status < 400;
      if (v === "error" || v === "err") return f.status != null && f.status >= 400;
      if (v === "client") return f.status != null && f.status >= 400 && f.status < 500;
      if (v === "server") return f.status != null && f.status >= 500;
      if (v === "pending") return f.status == null;
      const n = Number(t.value);
      return !Number.isNaN(n) && f.status != null && cmpNum(t.op, f.status, n);
    }
    case "size": {
      const n = parseSize(t.value);
      if (n == null) return false;
      return cmpNum(t.op, f.resSize + f.reqSize, n);
    }
    case "duration": {
      const n = Number(t.value);
      if (Number.isNaN(n) || f.durationMs == null) return false;
      return cmpNum(t.op, f.durationMs, n);
    }
    case "mime":
    case "type": {
      const ct = (f.resContentType || f.reqContentType || "").toLowerCase();
      return ct.includes(v);
    }
    case "header": {
      const [name, ...rest] = t.value.split("=");
      const want = rest.join("=").toLowerCase();
      const search = (hs: [string, string][]) =>
        hs.some(([k, val]) => k.toLowerCase() === name.toLowerCase()
          && (want === "" || val.toLowerCase().includes(want)));
      return search(f.reqHeaders) || search(f.resHeaders);
    }
    case "body": {
      const a = (f.reqBody ?? "").toLowerCase();
      const b = (f.resBody ?? "").toLowerCase();
      return a.includes(v) || b.includes(v);
    }
  }
  return false;
}

function parseSize(s: string): number | null {
  const m = s.match(/^(\d+(?:\.\d+)?)(b|k|kb|m|mb)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || "b").toLowerCase();
  if (u === "k" || u === "kb") return n * 1024;
  if (u === "m" || u === "mb") return n * 1024 * 1024;
  return n;
}

export function applyFilter(flows: Flow[], q: string): Flow[] {
  if (!q.trim()) return flows;
  const { tokens, freeText } = parseQuery(q);
  return flows.filter((f) => {
    for (const t of tokens) {
      const ok = matchToken(f, t);
      if (t.negate ? ok : !ok) return false;
    }
    if (freeText) {
      const hay = `${f.method} ${f.host} ${f.path} ${f.status ?? ""}`.toLowerCase();
      if (!hay.includes(freeText)) return false;
    }
    return true;
  });
}
