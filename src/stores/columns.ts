import { create } from "zustand";

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
  } catch { return DEFAULT.map((c) => ({ ...c })); }
}

function persist(list: Col[]) { localStorage.setItem(KEY, JSON.stringify(list)); }

type ColumnsState = {
  list: Col[];
  toggle: (id: ColId) => void;
  setWidth: (id: ColId, w: number) => void;
  move: (id: ColId, toIndex: number) => void;
  reset: () => void;
};

export const useColumns = create<ColumnsState>((set, get) => ({
  list: load(),
  toggle(id) {
    const list = get().list.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c));
    set({ list }); persist(list);
  },
  setWidth(id, w) {
    const list = get().list.map((c) => {
      if (c.id !== id) return c;
      const min = MIN_COL_WIDTH[id] ?? 40;
      return { ...c, width: Math.max(min, Math.min(800, Math.round(w))) };
    });
    set({ list }); persist(list);
  },
  move(id, toIndex) {
    const cur = get().list;
    const from = cur.findIndex((x) => x.id === id);
    if (from === -1) return;
    const list = cur.slice();
    const [item] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, item);
    set({ list }); persist(list);
  },
  reset() {
    const list = DEFAULT.map((c) => ({ ...c }));
    set({ list }); persist(list);
  },
}));
