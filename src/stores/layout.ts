import { create } from "zustand";

export type InspectorPos = "right" | "bottom" | "hidden";

const KEY = "tucano:layout";
type State = { pos: InspectorPos; rightPct: number; bottomPct: number };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "");
    return {
      pos: s.pos ?? "right",
      rightPct: clamp(s.rightPct ?? 55, 20, 85),
      bottomPct: clamp(s.bottomPct ?? 55, 20, 85),
    };
  } catch { return { pos: "right", rightPct: 55, bottomPct: 55 }; }
}

function persist(s: State) { localStorage.setItem(KEY, JSON.stringify(s)); }

type LayoutState = State & {
  setPos: (p: InspectorPos) => void;
  setRightPct: (n: number) => void;
  setBottomPct: (n: number) => void;
  cyclePos: () => void;
};

export const useLayout = create<LayoutState>((set, get) => ({
  ...load(),
  setPos(p) { const s = { ...get(), pos: p }; set({ pos: p }); persist(s); },
  setRightPct(n) { const v = clamp(n, 20, 85); set({ rightPct: v }); persist({ ...get(), rightPct: v }); },
  setBottomPct(n) { const v = clamp(n, 20, 85); set({ bottomPct: v }); persist({ ...get(), bottomPct: v }); },
  cyclePos() {
    const order: InspectorPos[] = ["right", "bottom", "hidden"];
    const i = order.indexOf(get().pos);
    const p = order[(i + 1) % order.length];
    set({ pos: p }); persist({ ...get(), pos: p });
  },
}));
