import { useEffect, useState } from "react";
import { ShieldCheck, Globe, Bot, Layers } from "lucide-react";
import { useFlows } from "@/stores/flows";
import { useUpdater } from "@/stores/updater";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Tone = "ok" | "warn" | "off";
const dotClass: Record<Tone, string> = {
  ok: "bg-emerald-400 shadow-[0_0_7px_rgb(52_211_153_/_0.7)]",
  warn: "bg-amber-400 shadow-[0_0_7px_rgb(251_191_36_/_0.6)]",
  off: "bg-ink-300/60 dark:bg-white/20",
};

function Indicator({ icon, tone, tooltip }: { icon: React.ReactNode; tone: Tone; tooltip: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative grid place-items-center h-6 w-6 rounded-md hover:bg-ink-100/60 dark:hover:bg-white/[0.05] transition cursor-default opacity-75 hover:opacity-100">
          {icon}
          <span className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-2 ring-[var(--tcn-canvas)] ${dotClass[tone]}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="mono text-[11px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const Divider = () => <span className="h-3.5 w-px bg-foreground/10 dark:bg-white/10" />;

export default function StatusBar() {
  const s = useFlows((st) => st.status);
  const flowsCount = useFlows((st) => st.flowsView.length);
  const uState = useUpdater((u) => u.state);
  const uProgress = useUpdater((u) => u.progress);
  const uVersion = useUpdater((u) => u.version);
  const restart = useUpdater((u) => u.restart);

  // MCP bridge status — fetched on mount; Settings dispatches `tucano:mcp-
  // changed` after a save so this stays in sync without polling.
  const [mcp, setMcp] = useState<{ enabled: boolean; port: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      ipc.getMcpSettings()
        .then((m) => { if (alive) setMcp({ enabled: m.enabled, port: m.port }); })
        .catch(() => {});
    load();
    const onChange = () => load();
    window.addEventListener("tucano:mcp-changed", onChange);
    return () => { alive = false; window.removeEventListener("tucano:mcp-changed", onChange); };
  }, []);

  return (
    <footer
      className="h-11 px-5 flex items-center gap-2.5 text-[11px] tcn-glass text-foreground/70 dark:text-ink-100 border-t border-ink-100/60 dark:border-white/[0.07] relative
        before:absolute before:inset-x-0 before:-top-px before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/[0.08] before:to-transparent before:pointer-events-none"
    >
      {/* Tagline — centered in the footer, behind the left/right clusters. */}
      <span className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 opacity-40 select-none text-[11px] pointer-events-none">
        <span className="h-1 w-1 rounded-full bg-toucan-400/70" />
        {t("sb.tagline")}
      </span>

      {/* Live proxy endpoint — the one detail worth keeping always visible. */}
      <span
        className={`flex items-center gap-2 mono font-medium h-[22px] px-2.5 rounded-lg transition-colors
          ${s.running
            ? "bg-toucan-400/12 text-toucan-300 ring-1 ring-inset ring-toucan-400/25 shadow-[0_0_18px_-6px_rgb(106_87_224_/_0.6)]"
            : "opacity-55"}`}
      >
        <span className="relative grid place-items-center h-1.5 w-1.5">
          {s.running && <span className="absolute inset-0 rounded-full bg-toucan-400/70 animate-ping" />}
          <span className={`relative h-1.5 w-1.5 rounded-full ${s.running ? "bg-toucan-400" : "bg-ink-200/60"}`} />
        </span>
        {s.running ? `127.0.0.1:${s.port}` : t("sb.proxyStopped")}
      </span>

      <Divider />

      {/* Capture count — always visible (it's the number people watch). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 px-1.5 h-6 rounded-md hover:bg-ink-100/60 dark:hover:bg-white/[0.05] transition cursor-default">
            <Layers size={13} className="opacity-55" />
            <span className="mono font-semibold text-toucan-300 tabular-nums">{flowsCount}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="text-[11px]">{t("sb.flows")}</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      {uState === "downloading" && (
        <span className="opacity-70 mono">{t("updater.downloading")} {Math.round(uProgress * 100)}%</span>
      )}
      {uState === "ready" && (
        <button
          onClick={() => restart()}
          title={t("updater.restartTitle")}
          className="mono text-toucan-300 hover:text-toucan-200 flex items-center gap-1.5 transition-colors"
        >
          ↻ {t("updater.ready")} v{uVersion} — {t("updater.restart")}
        </button>
      )}

      {/* Compact status indicators — pushed to the right. Detail on hover. */}
      <Indicator
        icon={<ShieldCheck size={13} />}
        tone={s.caInstalled ? "ok" : "warn"}
        tooltip={<>{t("sb.ca")}: {s.caInstalled ? t("sb.caTrusted") : t("sb.caNotInstalled")}</>}
      />
      <Indicator
        icon={<Globe size={13} />}
        tone={s.systemProxyOn ? "ok" : "off"}
        tooltip={<>{t("sb.sysProxy")}: {s.systemProxyOn ? t("sb.on") : t("sb.off")}</>}
      />
      <Indicator
        icon={<Bot size={13} />}
        tone={mcp?.enabled ? "ok" : "off"}
        tooltip={mcp?.enabled ? <>MCP: <span className="text-emerald-400">127.0.0.1:{mcp.port}</span></> : <>MCP: {t("sb.off")}</>}
      />
    </footer>
  );
}
