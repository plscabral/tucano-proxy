import { useState } from "react";
import { Sun, Moon, Monitor, Settings as Cog, Play, Pause, Loader2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFlows } from "@/stores/flows";
import { ipc } from "@/lib/ipc";
import { useTheme, toggleTheme } from "@/stores/theme";
import { t } from "@/lib/i18n";
import { Accent } from "@/components/Display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import logo from "@/assets/tucano-proxy-mark.svg";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

async function refresh() { useFlows.getState().setStatus(await ipc.status()); }

export default function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const running = useFlows((s) => s.status.running);
  const port = useFlows((s) => s.status.port);
  const mode = useTheme((s) => s.mode);
  const [busy, setBusy] = useState(false);

  const toggle = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur(); // avoid Space double-toggle
    if (busy) return;
    setBusy(true);
    try {
      if (running) await ipc.stopCapture(); else await ipc.startCapture(port);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const themeIcon = mode === "dark" ? <Moon size={15} /> : mode === "light" ? <Sun size={15} /> : <Monitor size={15} />;

  // Drag the window from the bar (except over controls); double-click maximizes.
  const isInteractive = (el: EventTarget | null) =>
    el instanceof Element && !!el.closest("button, a, input, select, [role='switch'], [data-no-drag]");
  const onBarMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    getCurrentWindow().startDragging().catch(() => {});
  };
  const onBarDoubleClick = (e: React.MouseEvent) => {
    if (isInteractive(e.target)) return;
    getCurrentWindow().toggleMaximize().catch(() => {});
  };

  return (
    <header
      onMouseDown={onBarMouseDown}
      onDoubleClick={onBarDoubleClick}
      style={{ paddingLeft: IS_MAC ? 96 : 20, paddingTop: IS_MAC ? 6 : 0 }}
      className="h-16 pr-4 flex items-center gap-2.5 tcn-glass relative select-none border-b border-ink-100/40 dark:border-white/[0.06]
        after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-gradient-to-r after:from-toucan-400/30 after:via-transparent after:to-transparent after:pointer-events-none"
    >
      <img src={logo} alt="Tucano Proxy" className="h-8 w-8 object-contain shrink-0" />
      <div className="text-[16px] leading-none">
        <span className="font-extrabold tracking-tight">Tucano</span>{" "}
        <Accent className="text-[17px] opacity-90">Proxy</Accent>
      </div>

      <div className="flex-1 h-full" />

      {/* Primary capture toggle — a labeled pill. Violet "go" when idle, a live
          red recording chip when capturing. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggle}
            disabled={busy}
            className={`h-9 pl-3 pr-3.5 rounded-xl flex items-center gap-2 text-xs font-semibold transition
              ${busy ? "opacity-70 cursor-not-allowed" : "hover:brightness-110"}
              ${running
                ? "bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/25 hover:bg-red-500/[0.16]"
                : "tcn-accent tcn-accent-glow"}`}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : running ? (
              <span className="relative grid place-items-center h-2 w-2">
                <span className="absolute inset-0 rounded-full bg-red-500/70 animate-ping" />
                <span className="relative h-2 w-2 rounded-full bg-red-500" />
              </span>
            ) : (
              <Play size={13} fill="currentColor" className="translate-x-px" />
            )}
            {busy ? t("topbar.busyTitle") : running ? t("topbar.capturing") : t("topbar.capture")}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {busy ? t("topbar.busyTitle") : running ? t("topbar.stopTitle") : t("topbar.startTitle")}
        </TooltipContent>
      </Tooltip>

      {/* Grouped secondary controls — contained so they don't float loosely. */}
      <div className="flex items-center gap-0.5 ml-1 p-0.5 rounded-xl ring-1 ring-inset ring-ink-100 dark:ring-white/[0.07] bg-ink-50/50 dark:bg-white/[0.02]">
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={toggleTheme} className="h-8 w-8 grid place-items-center rounded-lg opacity-75 hover:opacity-100 hover:bg-ink-100/70 dark:hover:bg-white/[0.06] transition">
              {themeIcon}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("topbar.toggleTheme")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenSettings} className="h-8 w-8 grid place-items-center rounded-lg opacity-75 hover:opacity-100 hover:bg-ink-100/70 dark:hover:bg-white/[0.06] transition">
              <Cog size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("topbar.settings")}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
