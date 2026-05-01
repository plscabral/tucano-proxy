import { createSignal, createEffect } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
// title bar would always show the static color from tauri.conf.json,
// leaving a dark stripe at the top of the window in light mode.
createEffect(() => {
  const dark = effectiveTheme() === "dark";
  // Match the CSS body backgrounds in styles.css so the title bar blends
  // perfectly with the rest of the app (no seam between OS chrome and TopBar).
  const color = dark ? "#0F182E" : "#FFFFFF";
  try {
    getCurrentWindow().setBackgroundColor(color).catch((e) => {
      console.warn("[theme] setBackgroundColor failed", e);
    });
  } catch (e) {
    // Not running inside Tauri (e.g. plain web preview) — ignore silently.
    void e;
  }
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
