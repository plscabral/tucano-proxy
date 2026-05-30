import { useState } from "react";
import { Sun, Moon, Monitor, Settings as Cog, Play, Pause, Loader2 } from "lucide-react";
import { useFlows } from "@/stores/flows";
import { ipc } from "@/lib/ipc";
import { useTheme, toggleTheme } from "@/stores/theme";
import { t } from "@/lib/i18n";
import { Accent } from "@/components/Display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import logo from "@/assets/tucano-proxy-mark.svg";

async function refresh() { useFlows.getState().setStatus(await ipc.status()); }

export default function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const running = useFlows((s) => s.status.running);
  const port = useFlows((s) => s.status.port);
  const mode = useTheme((s) => s.mode);
  const [busy, setBusy] = useState(false);

  const toggle = async (e: React.MouseEvent<HTMLButtonElement>) => {
    // Drop focus so a follow-up Space key doesn't double-toggle.
    e.currentTarget.blur();
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

  return (
    <header className="h-14 px-5 flex items-center gap-3 tcn-glass border-b border-ink-100/40 dark:border-white/[0.06] relative">
      <img src={logo} alt="Tucano Proxy" className="h-9 w-9 object-contain shrink-0" />
      <div className="text-[17px] leading-none">
        <span className="font-extrabold tracking-tight">Tucano</span>{" "}
        <Accent className="text-[18px] opacity-90">Proxy</Accent>
      </div>
      <span className="text-[10px] uppercase tracking-[0.22em] text-toucan-400 mt-0.5 font-semibold">v0.1</span>

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggle}
            disabled={busy}
            className={`h-9 w-9 grid place-items-center rounded-xl transition
              ${busy ? "opacity-60 cursor-not-allowed" : ""}
              ${running
                ? "text-red-500 hover:bg-red-500/10 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.15)]"
                : "text-emerald-500 hover:bg-emerald-500/10 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.15)]"}`}
          >
            {busy
              ? <Loader2 size={15} className="animate-spin" />
              : running
                ? <Pause size={15} fill="currentColor" />
                : <Play size={15} fill="currentColor" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {busy ? t("topbar.busyTitle") : running ? t("topbar.stopTitle") : t("topbar.startTitle")}
        </TooltipContent>
      </Tooltip>

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
