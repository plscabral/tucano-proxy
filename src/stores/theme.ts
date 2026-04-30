import { createSignal, createEffect } from "solid-js";

export type ThemeMode = "dark" | "light" | "system";

const KEY = "tucano:theme";
const initial = (localStorage.getItem(KEY) as ThemeMode) || "system";

const [mode, setMode] = createSignal<ThemeMode>(initial);
const [systemDark, setSystemDark] = createSignal(
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
);

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", (e) => setSystemDark(e.matches));
}

export const effectiveTheme = () => {
  const m = mode();
  if (m === "system") return systemDark() ? "dark" : "light";
  return m;
};

createEffect(() => {
  document.documentElement.classList.toggle("dark", effectiveTheme() === "dark");
});

// Keep the macOS native title bar (Transparent style) in sync with the
// active theme by repainting the window background. Without this, the
// title bar would always show the static color from tauri.conf.json.
createEffect(() => {
  const dark = effectiveTheme() === "dark";
  const color = dark
    ? { red: 12, green: 20, blue: 46, alpha: 255 }   // #0C142E (ink-500)
    : { red: 255, green: 255, blue: 255, alpha: 255 }; // white
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setBackgroundColor(color))
    .catch(() => { /* not running under Tauri */ });
});

export function setTheme(t: ThemeMode) {
  setMode(t);
  localStorage.setItem(KEY, t);
}
export function toggleTheme() {
  const order: ThemeMode[] = ["light", "dark", "system"];
  const i = order.indexOf(mode());
  setTheme(order[(i + 1) % order.length]);
}
export const themeMode = mode;
// Backwards-compat — many places import { theme }; keep it returning effective.
export const theme = effectiveTheme;
