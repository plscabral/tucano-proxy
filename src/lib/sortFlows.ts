import type { Flow } from "./types";
import type { ColId } from "../stores/columns";

function key(f: Flow, by: ColId): string | number {
  switch (by) {
    case "index":    return f.index;
    case "method":   return f.method;
    case "status":   return f.status ?? -1;
    case "host":     return f.host;
    case "path":     return f.path;
    case "size":     return (f.resSize || 0) + (f.reqSize || 0);
    case "duration": return f.durationMs ?? -1;
    case "client":   return f.clientApp ?? "";
    case "scheme":   return f.scheme;
    case "mime":     return (f.resContentType || f.reqContentType || "");
    case "note":     return f.note ?? "";
  }
}

export function sortFlows(flows: Flow[], by: ColId | null, dir: "asc" | "desc"): Flow[] {
  if (!by) return flows;
  const sorted = flows.slice().sort((a, b) => {
    const ka = key(a, by);
    const kb = key(b, by);
    if (typeof ka === "number" && typeof kb === "number") return ka - kb;
    return String(ka).localeCompare(String(kb));
  });
  if (dir === "desc") sorted.reverse();
  return sorted;
}
