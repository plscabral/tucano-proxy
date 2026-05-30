import { create } from "zustand";

const KEY = "tucano:prefs";

type Prefs = {
  autoCapture: boolean;
  keepLimit: number; // 0 = all sessions
};

const DEFAULTS: Prefs = { autoCapture: true, keepLimit: 0 };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

type PrefsState = Prefs & {
  setAutoCapture: (on: boolean) => void;
  setKeepLimit: (n: number) => void;
};

function save(next: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setAutoCapture(on) {
    const next = { autoCapture: on, keepLimit: get().keepLimit };
    set({ autoCapture: on }); save(next);
  },
  setKeepLimit(n) {
    const next = { autoCapture: get().autoCapture, keepLimit: n };
    set({ keepLimit: n }); save(next);
  },
}));
