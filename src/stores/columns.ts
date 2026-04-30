import { createStore, produce } from "solid-js/store";

export type ColId = "index" | "method" | "status" | "host" | "path" | "size" | "duration" | "client" | "scheme" | "mime" | "note";

export type Col = { id: ColId; label: string; width: number; visible: boolean };

export const ALL_COLUMNS: Record<ColId, { label: string; width: number }> = {
  index:    { label: "#",        width: 50 },
  method:   { label: "Method",   width: 76 },
  status:   { label: "Status",   width: 68 },
  host:     { label: "Host",     width: 220 },
  path:     { label: "Path",     width: 320 },
  size:     { label: "Size",     width: 80 },
  duration: { label: "Time",     width: 80 },
  client:   { label: "Client",   width: 140 },
  scheme:   { label: "Scheme",   width: 70 },
  mime:     { label: "MIME",     width: 140 },
  note:     { label: "Note",     width: 240 },
};

const DEFAULT: Col[] = [
  { id: "index",    label: "#",      width: 50,  visible: true },
  { id: "method",   label: "Method", width: 76,  visible: true },
  { id: "status",   label: "Status", width: 68,  visible: true },
  { id: "client",   label: "Client", width: 140, visible: true },
  { id: "host",     label: "Host",   width: 220, visible: true },
  { id: "path",     label: "Path",   width: 320, visible: true },
  { id: "size",     label: "Size",   width: 80,  visible: true },
  { id: "duration", label: "Time",   width: 80,  visible: true },
  { id: "note",     label: "Note",   width: 240, visible: true },
  { id: "scheme",   label: "Scheme", width: 70,  visible: false },
  { id: "mime",     label: "MIME",   width: 140, visible: false },
];

const KEY = "tucano:columns";

function load(): Col[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "");
    if (!Array.isArray(saved)) throw new Error();
    // ensure any newly-added columns appear at the end as hidden
    const seen = new Set(saved.map((c: Col) => c.id));
    const merged = [...saved];
    for (const d of DEFAULT) if (!seen.has(d.id)) merged.push({ ...d, visible: false });
    return merged;
  } catch { return DEFAULT; }
}

const [state, setState] = createStore<{ list: Col[] }>({ list: load() });

function persist() { localStorage.setItem(KEY, JSON.stringify(state.list)); }

export const columnsStore = {
  cols: () => state.list,
  visible: () => state.list.filter((c) => c.visible),
  toggle(id: ColId) {
    setState(produce((s) => {
      const c = s.list.find((x) => x.id === id);
      if (c) c.visible = !c.visible;
    }));
    persist();
  },
  setWidth(id: ColId, w: number) {
    setState(produce((s) => {
      const c = s.list.find((x) => x.id === id);
      if (c) c.width = Math.max(40, Math.min(800, Math.round(w)));
    }));
    persist();
  },
  move(id: ColId, toIndex: number) {
    setState(produce((s) => {
      const from = s.list.findIndex((x) => x.id === id);
      if (from === -1) return;
      const [item] = s.list.splice(from, 1);
      s.list.splice(Math.max(0, Math.min(s.list.length, toIndex)), 0, item);
    }));
    persist();
  },
  reset() { setState("list", DEFAULT.map((c) => ({ ...c }))); persist(); },
};
