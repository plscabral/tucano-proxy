import { preferenceStorage } from "@/lib/platform";
import { create } from "zustand";

const KEY = "tucano:prefs";

type Prefs = {
  autoCapture: boolean;
  keepLimit: number; // 0 = all sessions
  privateMode: boolean;
  capturePort: number | null;
};

const DEFAULTS: Prefs = { autoCapture: true, keepLimit: 0, privateMode: false, capturePort: null };

function load(): Prefs {
  try {
    const raw = preferenceStorage.getItem(KEY);
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
  setCapturePort: (port: number) => void;
};

function save(next: Prefs) {
  try { preferenceStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setAutoCapture(on) {
    const next = { autoCapture: on, keepLimit: get().keepLimit, privateMode: get().privateMode, capturePort: get().capturePort };
    set({ autoCapture: on }); save(next);
  },
  setKeepLimit(n) {
    const next = { autoCapture: get().autoCapture, keepLimit: n, privateMode: get().privateMode, capturePort: get().capturePort };
    set({ keepLimit: n }); save(next);
  },
  setPrivateMode(on) {
    const next = { autoCapture: get().autoCapture, keepLimit: get().keepLimit, privateMode: on, capturePort: get().capturePort };
    set({ privateMode: on }); save(next);
  },
  setCapturePort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Proxy port must be an integer from 1 to 65535.");
    const next = { autoCapture: get().autoCapture, keepLimit: get().keepLimit, privateMode: get().privateMode, capturePort: port };
    set({ capturePort: port }); save(next);
  },
}));
