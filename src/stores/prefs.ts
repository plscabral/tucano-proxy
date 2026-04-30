import { createSignal } from "solid-js";

const KEY = "tucano:prefs";

type Prefs = {
  autoCapture: boolean; // start capturing automatically when the app launches
};

const DEFAULTS: Prefs = { autoCapture: true };

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
};
