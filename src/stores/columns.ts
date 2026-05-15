import { createStore, produce } from "solid-js/store";

export type ColId = "index" | "method" | "status" | "host" | "path" | "size" | "duration" | "client" | "scheme" | "mime" | "charset" | "note";

export type Col = { id: ColId; label: string; width: number; visible: boolean };

// Minimum widths chosen so the longest translated header label
// (uppercase + tracking) fits without truncation, accounting for the
// header's grip icon, padding and resize handle (~45px overhead).
export const MIN_COL_WIDTH: Record<ColId, number> = {
  index:    78,
  method:   100,
  status:   96,
  host:     140,
  path:     160,
  size:     108,
  duration: 100,
  client:   120,
  scheme:   116,
  mime:     108,
  charset:  108,
  note:     160,
};

export const ALL_COLUMNS: Record<ColId, { label: string; width: number }> = {
  index:    { label: "#",        width: 78 },
  method:   { label: "Method",   width: 100 },
  status:   { label: "Status",   width: 96 },
  host:     { label: "Host",     width: 220 },
  path:     { label: "Path",     width: 320 },
  size:     { label: "Size",     width: 108 },
  duration: { label: "Time",     width: 100 },
  client:   { label: "Client",   width: 140 },
  scheme:   { label: "Scheme",   width: 116 },
  mime:     { label: "MIME",     width: 140 },
  charset:  { label: "Charset",  width: 120 },
  note:     { label: "Note",     width: 240 },
};

const DEFAULT: Col[] = [
  { id: "index",    label: "#",      width: 78,  visible: true },
  { id: "method",   label: "Method", width: 100, visible: true },
  { id: "status",   label: "Status", width: 96,  visible: true },
  { id: "client",   label: "Client", width: 140, visible: true },
  { id: "host",     label: "Host",   width: 220, visible: true },
  { id: "path",     label: "Path",   width: 320, visible: true },
  { id: "size",     label: "Size",   width: 108, visible: true },
  { id: "duration", label: "Time",   width: 100, visible: true },
  { id: "note",     label: "Note",   width: 240, visible: true },
  { id: "scheme",   label: "Scheme", width: 116, visible: true },
  { id: "mime",     label: "MIME",   width: 140, visible: true },
  { id: "charset",  label: "Charset",width: 120, visible: true },
];

// Bumped to v2 to drop pre-charset cached prefs (where scheme/mime were
// hidden by default). Users get the new "all visible" defaults; they can
// still hide what they don't want from the columns menu.
const KEY = "tucano:columns:v2";

function load(): Col[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "");
    if (!Array.isArray(saved)) throw new Error();
    // ensure any newly-added columns appear at the end as hidden
    const seen = new Set(saved.map((c: Col) => c.id));
    const merged = [...saved];
    for (const d of DEFAULT) if (!seen.has(d.id)) merged.push({ ...d, visible: false });
    for (const c of merged) {
      const min = MIN_COL_WIDTH[c.id as ColId];
      if (min && c.width < min) c.width = min;
    }
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
      if (c) {
        const min = MIN_COL_WIDTH[id] ?? 40;
        c.width = Math.max(min, Math.min(800, Math.round(w)));
      }
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
