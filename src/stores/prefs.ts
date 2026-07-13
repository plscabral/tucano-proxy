import { create } from "zustand";

const KEY = "tucano:prefs";

type Prefs = {
  autoCapture: boolean;
  keepLimit: number; // 0 = all sessions
  privateMode: boolean;
};

const DEFAULTS: Prefs = { autoCapture: true, keepLimit: 0, privateMode: false };

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
  setPrivateMode: (on: boolean) => void;
};

function save(next: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setAutoCapture(on) {
    const next = { autoCapture: on, keepLimit: get().keepLimit, privateMode: get().privateMode };
    set({ autoCapture: on }); save(next);
  },
  setKeepLimit(n) {
    const next = { autoCapture: get().autoCapture, keepLimit: n, privateMode: get().privateMode };
    set({ keepLimit: n }); save(next);
  },
  setPrivateMode(on) {
    const next = { autoCapture: get().autoCapture, keepLimit: get().keepLimit, privateMode: on };
    set({ privateMode: on }); save(next);
  },
}));
