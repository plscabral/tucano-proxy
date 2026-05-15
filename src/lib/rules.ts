import type { Flow } from "./types";

const _reCache = new Map<string, RegExp | null>();

export type Field =
  | "url" | "host" | "path" | "method" | "status"
  | "mime" | "header" | "body" | "duration" | "size" | "scheme";

export type Op =
  | "contains" | "not_contains" | "equals" | "not_equals"
  | "starts_with" | "ends_with" | "matches"
  | "gt" | "gte" | "lt" | "lte";

export type Rule = {
  id: string;
  enabled: boolean;
  field: Field;
  op: Op;
  value: string;
};

export const FIELDS: { id: Field; label: string; kind: "string" | "number" | "header" }[] = [
  { id: "url",      label: "URL",      kind: "string" },
  { id: "host",     label: "Host",     kind: "string" },
  { id: "path",     label: "Path",     kind: "string" },
  { id: "method",   label: "Method",   kind: "string" },
  { id: "status",   label: "Status",   kind: "number" },
  { id: "scheme",   label: "Scheme",   kind: "string" },
  { id: "mime",     label: "MIME",     kind: "string" },
  { id: "header",   label: "Header",   kind: "header" },
  { id: "body",     label: "Body",     kind: "string" },
  { id: "duration", label: "Duration (ms)", kind: "number" },
  { id: "size",     label: "Size (bytes)", kind: "number" },
];

export const STRING_OPS: { id: Op; label: string }[] = [
  { id: "contains",     label: "Contains" },
  { id: "not_contains", label: "Does not contain" },
  { id: "equals",       label: "Equals" },
  { id: "not_equals",   label: "Does not equal" },
  { id: "starts_with",  label: "Starts with" },
  { id: "ends_with",    label: "Ends with" },
  { id: "matches",      label: "Matches regex" },
];

export const NUMBER_OPS: { id: Op; label: string }[] = [
  { id: "equals",     label: "=" },
  { id: "not_equals", label: "≠" },
  { id: "gt",         label: ">" },
  { id: "gte",        label: "≥" },
  { id: "lt",         label: "<" },
  { id: "lte",        label: "≤" },
];

export function opsFor(field: Field): { id: Op; label: string }[] {
  const f = FIELDS.find((x) => x.id === field)!;
  return f.kind === "number" ? NUMBER_OPS : STRING_OPS;
}

function fieldString(f: Flow, field: Field, valueRaw: string): string {
  switch (field) {
    case "url": {
      const port = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80)
        ? "" : ":" + f.port;
      return `${f.scheme}://${f.host}${port}${f.path}`;
    }
    case "host": return f.host;
    case "path": return f.path;
    case "method": return f.method;
    case "scheme": return f.scheme;
    case "mime": return (f.resContentType || f.reqContentType || "");
    case "body": return `${f.reqBody ?? ""}\n${f.resBody ?? ""}`;
    case "header": {
      // value format: "Name: needle" or just "Name"
      const [name, ...rest] = valueRaw.split(":");
      const want = rest.join(":").trim().toLowerCase();
      const all = [...f.reqHeaders, ...f.resHeaders];
      const found = all.filter(([k]) => k.toLowerCase() === name.trim().toLowerCase());
      if (found.length === 0) return "";
      if (!want) return found.map(([, v]) => v).join("\n");
      return found.map(([, v]) => v).join("\n");
    }
    default: return "";
  }
}

function fieldNumber(f: Flow, field: Field): number | null {
  switch (field) {
    case "status": return f.status ?? null;
    case "duration": return f.durationMs ?? null;
    case "size": return f.reqSize + f.resSize;
    default: return null;
  }
}

function strOp(op: Op, hay: string, needle: string): boolean {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  switch (op) {
    case "contains":     return h.includes(n);
    case "not_contains": return !h.includes(n);
    case "equals":       return h === n;
    case "not_equals":   return h !== n;
    case "starts_with":  return h.startsWith(n);
    case "ends_with":    return h.endsWith(n);
    case "matches": {
      let re = _reCache.get(needle);
      if (re === undefined) {
        try { re = new RegExp(needle, "i"); } catch { re = null; }
        _reCache.set(needle, re);
      }
      return re ? re.test(hay) : false;
    }
    default: return false;
  }
}

function numOp(op: Op, a: number, b: number): boolean {
  switch (op) {
    case "equals":     return a === b;
    case "not_equals": return a !== b;
    case "gt":  return a > b;
    case "gte": return a >= b;
    case "lt":  return a < b;
    case "lte": return a <= b;
    default: return false;
  }
}

// Multi-value support: a rule value like "pje, localhost" matches if ANY
// substring matches (positive ops) or NONE match (negative ops). Splitting
// is skipped for `matches` (regex can legitimately contain commas) and for
// the `header` field (its own "Name: value" syntax owns the colon/comma).
function splitValues(value: string, op: Op, field: Field): string[] {
  if (op === "matches" || field === "header") return [value];
  const parts = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return parts.length > 0 ? parts : [value];
}

const NEGATIVE_OPS = new Set<Op>(["not_contains", "not_equals"]);

export function evalRule(f: Flow, r: Rule): boolean {
  const meta = FIELDS.find((x) => x.id === r.field)!;
  if (meta.kind === "number") {
    const a = fieldNumber(f, r.field);
    const b = Number(r.value);
    if (a == null || Number.isNaN(b)) return false;
    return numOp(r.op, a, b);
  }
  if (r.field === "header") {
    const [name, ...rest] = r.value.split(":");
    const want = rest.join(":").trim();
    if (!name.trim()) return false;
    const all = [...f.reqHeaders, ...f.resHeaders];
    const found = all.filter(([k]) => k.toLowerCase() === name.trim().toLowerCase());
    if (found.length === 0) return NEGATIVE_OPS.has(r.op);
    if (!want) return !NEGATIVE_OPS.has(r.op);
    return found.some(([, v]) => strOp(r.op, v, want));
  }
  const hay = fieldString(f, r.field, r.value);
  const needles = splitValues(r.value, r.op, r.field);
  // Negative ops compose with AND (must NOT contain ANY of the values),
  // positive ops compose with OR (must contain at least ONE).
  return NEGATIVE_OPS.has(r.op)
    ? needles.every((n) => strOp(r.op, hay, n))
    : needles.some((n) => strOp(r.op, hay, n));
}

export function applyRules(flows: Flow[], rules: Rule[], mode: "all" | "any" = "all"): Flow[] {
  const active = rules.filter((r) => r.enabled && r.value.trim() !== "");
  if (active.length === 0) return flows;
  return mode === "any"
    ? flows.filter((f) => active.some((r) => evalRule(f, r)))
    : flows.filter((f) => active.every((r) => evalRule(f, r)));
}

export function newRule(): Rule {
  return {
    id: Math.random().toString(36).slice(2, 10),
    enabled: true,
    field: "url",
    op: "contains",
    value: "",
  };
}
