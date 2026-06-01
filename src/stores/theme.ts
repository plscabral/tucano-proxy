import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "dark" | "light" | "system";

const KEY = "tucano:theme";
const initialMode = (localStorage.getItem(KEY) as ThemeMode) || "system";

type ThemeState = {
  mode: ThemeMode;
  systemDark: boolean;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
};

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode,
  systemDark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  setMode(m) {
    localStorage.setItem(KEY, m);
    set({ mode: m });
  },
  toggle() {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const i = order.indexOf(get().mode);
    get().setMode(order[(i + 1) % order.length]);
  },
}));

export const effectiveTheme = (): "dark" | "light" => {
  const { mode, systemDark } = useTheme.getState();
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
};

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", (e) => useTheme.setState({ systemDark: e.matches }));
}

// Side effects: toggle the `dark` class on <html> and keep the macOS native
// title bar (Transparent style) in sync by repainting the window background.
// Matches the CSS body backgrounds in styles.css so there's no seam between
// OS chrome and the TopBar.
function applyTheme() {
  const { mode } = useTheme.getState();
  const dark = effectiveTheme() === "dark";
  document.documentElement.classList.toggle("dark", dark);
  const color = dark ? "#0F1014" : "#FBFBF8";
  try {
    const win = getCurrentWindow();
    win.setBackgroundColor(color).catch((e) => {
      console.warn("[theme] setBackgroundColor failed", e);
    });
    // macOS: the native title bar (Transparent style) follows the WINDOW
    // theme, not the background color — without this it stays dark/black while
    // the app is in light mode. setTheme repaints the title bar to match.
    //
    // In "system" mode we pass null so the window keeps following the OS
    // appearance. Forcing a concrete theme here would flip the WebView's
    // prefers-color-scheme to the forced value, firing the matchMedia listener
    // below and corrupting `systemDark` — which then locks "system" mode onto
    // whatever was last forced (the dark-stuck bug).
    win.setTheme(mode === "system" ? null : dark ? "dark" : "light").catch((e) => {
      console.warn("[theme] setTheme failed", e);
    });
  } catch (e) {
    // Not running inside Tauri (e.g. plain web preview) — ignore silently.
    void e;
  }
}

applyTheme();
useTheme.subscribe(applyTheme);

// Reactive effective theme for components (e.g. CodeMirror editors that must
// rebuild their theme extensions on light/dark switch).
export const useEffectiveTheme = (): "dark" | "light" =>
  useTheme((s) => (s.mode === "system" ? (s.systemDark ? "dark" : "light") : s.mode));

export const themeMode = (): ThemeMode => useTheme.getState().mode;
export const setTheme = (m: ThemeMode) => useTheme.getState().setMode(m);
export const toggleTheme = () => useTheme.getState().toggle();
