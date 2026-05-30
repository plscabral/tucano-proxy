import { useEffect, useState } from "react";
import { useFlows } from "@/stores/flows";
import { useUpdater } from "@/stores/updater";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-[0.14em] opacity-40">{label}</span>
      <span className="mono text-[11px]">{children}</span>
    </span>
  );
}

const Divider = () => <span className="h-3 w-px bg-foreground/10 dark:bg-white/10" />;

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
      className="h-9 px-6 flex items-center gap-4 text-[11px] tcn-glass text-foreground/70 dark:text-ink-100 border-t border-ink-100/60 dark:border-white/[0.07] relative
        before:absolute before:inset-x-0 before:-top-px before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/[0.08] before:to-transparent before:pointer-events-none"
    >
      {/* Live proxy endpoint — glows violet when capturing. */}
      <span
        className={`flex items-center gap-2 mono font-medium h-[22px] px-2.5 rounded-lg transition-colors
          ${s.running
            ? "bg-toucan-400/12 text-toucan-300 ring-1 ring-inset ring-toucan-400/25 shadow-[0_0_18px_-6px_rgb(106_87_224_/_0.6)]"
            : "opacity-55"}`}
      >
        <span className={`relative grid place-items-center h-1.5 w-1.5`}>
          {s.running && <span className="absolute inset-0 rounded-full bg-toucan-400/70 animate-ping" />}
          <span className={`relative h-1.5 w-1.5 rounded-full ${s.running ? "bg-toucan-400" : "bg-ink-200/60"}`} />
        </span>
        {s.running ? `127.0.0.1:${s.port}` : t("sb.proxyStopped")}
      </span>

      <Divider />
      <Stat label={t("sb.flows")}><span className="text-toucan-300 font-semibold">{flowsCount}</span></Stat>
      <Divider />
      <Stat label={t("sb.ca")}>
        <span className={s.caInstalled ? "text-emerald-400 font-medium" : "text-amber-400 font-medium"}>
          {s.caInstalled ? t("sb.caTrusted") : t("sb.caNotInstalled")}
        </span>
      </Stat>
      <Divider />
      <Stat label={t("sb.sysProxy")}>
        <span className={s.systemProxyOn ? "text-emerald-400 font-medium" : "opacity-60"}>
          {s.systemProxyOn ? t("sb.on") : t("sb.off")}
        </span>
      </Stat>
      <Divider />
      <Stat label="MCP">
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${mcp?.enabled ? "bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153_/_0.7)]" : "bg-ink-200/60 dark:bg-white/15"}`} />
          {mcp?.enabled
            ? <span className="text-emerald-400 font-medium">{`127.0.0.1:${mcp.port}`}</span>
            : <span className="opacity-60">{t("sb.off")}</span>}
        </span>
      </Stat>

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

      {/* Tagline — muted, with the brand dot. */}
      <span className="flex items-center gap-1.5 opacity-45 select-none text-[11px]">
        <span className="h-1 w-1 rounded-full bg-toucan-400/70" />
        {t("sb.tagline")}
      </span>
    </footer>
  );
}
