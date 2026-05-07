import { createSignal } from "solid-js";

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

const [prefs, setPrefs] = createSignal<Prefs>(load());

function save(next: Prefs) {
  setPrefs(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}

export const prefsStore = {
  prefs,
  setAutoCapture(on: boolean) { save({ ...prefs(), autoCapture: on }); },
  setKeepLimit(n: number) { save({ ...prefs(), keepLimit: n }); },
};
