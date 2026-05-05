import { Sun, Moon, Monitor, Settings as Cog, Play, Pause, Loader2 } from "lucide-solid";
import { createSignal } from "solid-js";
import { flowsStore } from "../stores/flows";
import { ipc } from "../lib/ipc";
import { themeMode, toggleTheme } from "../stores/theme";
import { t } from "../lib/i18n";
import logo from "../assets/logo.png";

async function refresh() { flowsStore.setStatus(await ipc.status()); }

export default function TopBar(props: { onOpenSettings: () => void }) {
  const s = flowsStore.status;
  const [busy, setBusy] = createSignal(false);
  const toggle = async (e: MouseEvent) => {
    // Drop focus so a follow-up Space key doesn't double-toggle (the
    // browser would re-fire click on the focused button AND the global
    // Space shortcut would also run).
    (e.currentTarget as HTMLButtonElement)?.blur();
    if (busy()) return;
    setBusy(true);
    try {
      if (s().running) await ipc.stopCapture(); else await ipc.startCapture(s().port);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // Inline JSX expression so Solid re-evaluates the icon when `themeMode()`
  // changes — wrapping the conditional in a regular function (`<ThemeIcon/>`)
  // would cache the first result and never update the icon.
  const themeIcon = () => {
    const m = themeMode();
    if (m === "dark") return <Moon size={15} />;
    if (m === "light") return <Sun size={15} />;
    return <Monitor size={15} />;
  };

  return (
    <header class="h-14 px-5 flex items-center gap-3 bg-white dark:bg-ink-500 border-b border-ink-100 dark:border-ink-400/30">
      <img src={logo} alt="Tucano Proxy" class="h-9 w-9 object-contain shrink-0" />
      <div class="font-semibold text-[15px] tracking-tight">Tucano <span class="opacity-70">Proxy</span></div>
      <span class="text-[10px] uppercase tracking-[0.18em] text-toucan-400/90 mt-0.5">v0.1</span>

      <div class="flex-1" />

      <button
        onClick={toggle}
        disabled={busy()}
        title={busy()
          ? t("topbar.busyTitle")
          : s().running ? t("topbar.stopTitle") : t("topbar.startTitle")}
        class={`h-9 w-9 grid place-items-center rounded-xl transition hover:bg-ink-50 dark:hover:bg-ink-400/20
          ${busy() ? "opacity-60 cursor-not-allowed" : ""}
          ${s().running ? "text-red-500" : "text-emerald-500"}`}
      >
        {busy()
          ? <Loader2 size={15} class="animate-spin" />
          : s().running
            ? <Pause size={15} fill="currentColor" />
            : <Play size={15} fill="currentColor" />}
      </button>

      <button
        onClick={toggleTheme}
        class="h-9 w-9 grid place-items-center rounded-xl opacity-70 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20 transition"
        title={t("topbar.toggleTheme")}
      >{themeIcon()}</button>

      <button
        onClick={props.onOpenSettings}
        class="h-9 w-9 grid place-items-center rounded-xl opacity-70 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20 transition"
        title={t("topbar.settings")}
      ><Cog size={15} /></button>
    </header>
  );
}
