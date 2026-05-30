import { useState } from "react";
import { Sun, Moon, Monitor, Settings as Cog, Play, Pause, Loader2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useFlows } from "@/stores/flows";
import { ipc } from "@/lib/ipc";
import { useTheme, toggleTheme } from "@/stores/theme";
import { t } from "@/lib/i18n";
import { Accent } from "@/components/Display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
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

  // Make the whole bar drag the window (like a native title bar) — except over
  // interactive controls. Done explicitly via startDragging() because the
  // data-tauri-drag-region attribute matches only the exact click target,
  // which is fragile with nested content.
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
      style={{ paddingLeft: IS_MAC ? 96 : 20 }}
      className="h-14 pr-4 flex items-center gap-2.5 tcn-glass relative select-none border-b border-ink-100/40 dark:border-white/[0.06]
        after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-gradient-to-r after:from-toucan-400/30 after:via-transparent after:to-transparent after:pointer-events-none"
    >
      <img src={logo} alt="Tucano Proxy" className="h-9 w-9 object-contain shrink-0" />
      <div className="text-[17px] leading-none">
        <span className="font-extrabold tracking-tight">Tucano</span>{" "}
        <Accent className="text-[18px] opacity-90">Proxy</Accent>
      </div>

      <div className="flex-1 h-full" />

      {/* Primary capture toggle — violet "go" when idle, red "stop" when live. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggle}
            disabled={busy}
            className={`h-9 w-9 grid place-items-center rounded-xl transition
              ${busy ? "opacity-60 cursor-not-allowed" : "hover:brightness-110"}
              ${running
                ? "bg-red-500/12 text-red-400 ring-1 ring-inset ring-red-500/25 hover:bg-red-500/18"
                : "tcn-accent tcn-accent-glow"}`}
          >
            {busy
              ? <Loader2 size={15} className="animate-spin" />
              : running
                ? <Pause size={15} fill="currentColor" />
                : <Play size={15} fill="currentColor" className="translate-x-px" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {busy ? t("topbar.busyTitle") : running ? t("topbar.stopTitle") : t("topbar.startTitle")}
        </TooltipContent>
      </Tooltip>

      <span className="h-5 w-px bg-ink-100 dark:bg-white/10 mx-0.5" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-9 w-9 rounded-xl opacity-70 hover:opacity-100">
            {themeIcon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("topbar.toggleTheme")}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={onOpenSettings} className="h-9 w-9 rounded-xl opacity-70 hover:opacity-100">
            <Cog size={15} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("topbar.settings")}</TooltipContent>
      </Tooltip>
    </header>
  );
}
