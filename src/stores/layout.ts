import { createSignal, createEffect } from "solid-js";

export type InspectorPos = "right" | "bottom" | "hidden";

const KEY = "tucano:layout";
type State = { pos: InspectorPos; rightPct: number; bottomPct: number };

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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const init = load();
const [pos, setPos] = createSignal<InspectorPos>(init.pos);
const [rightPct, setRightPct] = createSignal(init.rightPct);
const [bottomPct, setBottomPct] = createSignal(init.bottomPct);

createEffect(() => {
  localStorage.setItem(KEY, JSON.stringify({
    pos: pos(), rightPct: rightPct(), bottomPct: bottomPct(),
  }));
});

export const layoutStore = {
  pos, setPos,
  rightPct,
  bottomPct,
  setRightPct: (n: number) => setRightPct(clamp(n, 20, 85)),
  setBottomPct: (n: number) => setBottomPct(clamp(n, 20, 85)),
  cyclePos() {
    const order: InspectorPos[] = ["right", "bottom", "hidden"];
    const i = order.indexOf(pos());
    setPos(order[(i + 1) % order.length]);
  },
};
