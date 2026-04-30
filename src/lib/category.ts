import type { Flow } from "./types";

export type Category =
  | "all" | "http" | "https" | "websocket"
  | "json" | "form" | "xml" | "js" | "css" | "graphql" | "document" | "media" | "other";

export const CATEGORIES: { id: Category; group: "proto" | "type" }[] = [
  { id: "all",       group: "proto" },
  { id: "http",      group: "proto" },
  { id: "https",     group: "proto" },
  { id: "websocket", group: "proto" },
  { id: "json",      group: "type" },
  { id: "form",      group: "type" },
  { id: "xml",       group: "type" },
  { id: "js",        group: "type" },
  { id: "css",       group: "type" },
  { id: "graphql",   group: "type" },
  { id: "document",  group: "type" },
  { id: "media",     group: "type" },
  { id: "other",     group: "type" },
];

function ct(f: Flow): string {
  return (f.resContentType || f.reqContentType || "").toLowerCase();
}

export function categoryOf(f: Flow): Category {
  const c = ct(f);
  const path = f.path.toLowerCase();
  if (c.includes("json") || /\.json(\?|$)/.test(path)) {
    if (path.includes("/graphql") || (f.reqBody && /["{ ]query["{ :]/.test(f.reqBody))) return "graphql";
    return "json";
  }
  if (c.includes("xml")) return "xml";
  if (c.includes("html") || c.includes("text/html")) return "document";
  if (c.includes("javascript") || c.includes("ecmascript") || /\.m?js(\?|$)/.test(path)) return "js";
  if (c.includes("css") || /\.css(\?|$)/.test(path)) return "css";
  if (c.includes("form-urlencoded") || c.includes("multipart/form")) return "form";
  if (c.startsWith("image/") || c.startsWith("video/") || c.startsWith("audio/")) return "media";
  if (c.startsWith("font/") || c.includes("font")) return "media";
  return "other";
}

export function matchesCategory(f: Flow, cat: Category): boolean {
  if (cat === "all") return true;
  if (cat === "http") return f.scheme === "http";
  if (cat === "https") return f.scheme === "https";
  if (cat === "websocket") {
    const upgrade = f.reqHeaders.find(([k]) => k.toLowerCase() === "upgrade");
    return !!upgrade && upgrade[1].toLowerCase() === "websocket";
  }
  return categoryOf(f) === cat;
}
