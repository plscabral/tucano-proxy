import { useFlows } from "@/stores/flows";
import { useUpdater } from "@/stores/updater";
import { t } from "@/lib/i18n";

export default function StatusBar() {
  const s = useFlows((st) => st.status);
  const flowsCount = useFlows((st) => st.flowsView.length);
  const uState = useUpdater((u) => u.state);
  const uProgress = useUpdater((u) => u.progress);
  const uVersion = useUpdater((u) => u.version);
  const restart = useUpdater((u) => u.restart);

  return (
    <footer className="h-8 px-5 flex items-center gap-5 text-[11px] tcn-glass text-ink-400 dark:text-ink-100 border-t border-ink-100/60 dark:border-white/10 relative">
      <span className={`mono flex items-center gap-1.5 ${s.running ? "text-toucan-400" : "opacity-60"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${s.running ? "bg-toucan-400 shadow-[0_0_8px_rgb(251_142_55_/_0.7)]" : "bg-ink-200/60"}`} />
        {s.running ? `127.0.0.1:${s.port}` : t("sb.proxyStopped")}
      </span>
      <span className="opacity-75 mono">{t("sb.flows")}: <span className="text-cobalt-400 font-medium">{flowsCount}</span></span>
      <span className="opacity-75 mono">{t("sb.ca")}: <span className={s.caInstalled ? "text-emerald-400 font-medium" : "text-amber-400 font-medium"}>{s.caInstalled ? t("sb.caTrusted") : t("sb.caNotInstalled")}</span></span>
      <span className="opacity-75 mono">{t("sb.sysProxy")}: <span className={s.systemProxyOn ? "text-emerald-400 font-medium" : "opacity-60"}>{s.systemProxyOn ? t("sb.on") : t("sb.off")}</span></span>
      <div className="flex-1" />

      {uState === "downloading" && (
        <span className="opacity-70 mono">
          {t("updater.downloading")} {Math.round(uProgress * 100)}%
        </span>
      )}
      {uState === "ready" && (
        <button
          onClick={() => restart()}
          title={t("updater.restartTitle")}
          className="mono text-toucan-400 hover:underline"
        >
          ↻ {t("updater.ready")} v{uVersion} — {t("updater.restart")}
        </button>
      )}

      <span className="opacity-50">{t("sb.tagline")}</span>
    </footer>
  );
}
