import type { Flow } from "./types";

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
    case "matches":
      try { return new RegExp(needle, "i").test(hay); } catch { return false; }
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
    if (found.length === 0) return r.op === "not_contains" || r.op === "not_equals";
    if (!want) return r.op !== "not_contains" && r.op !== "not_equals";
    return found.some(([, v]) => strOp(r.op, v, want));
  }
  return strOp(r.op, fieldString(f, r.field, r.value), r.value);
}

export function applyRules(flows: Flow[], rules: Rule[]): Flow[] {
  const active = rules.filter((r) => r.enabled && r.value.trim() !== "");
  if (active.length === 0) return flows;
  return flows.filter((f) => active.every((r) => evalRule(f, r)));
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
