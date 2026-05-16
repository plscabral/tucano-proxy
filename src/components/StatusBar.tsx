import { Show } from "solid-js";
import { flowsStore } from "../stores/flows";
import { updaterStore } from "../stores/updater";
import { t } from "../lib/i18n";

export default function StatusBar() {
  const s = flowsStore.status;
  const u = updaterStore;
  return (
    <footer class="h-8 px-5 flex items-center gap-5 text-[11px] tcn-glass text-ink-400 dark:text-ink-100 border-t border-ink-100/60 dark:border-white/10 relative">
      <span class={`mono flex items-center gap-1.5 ${s().running ? "text-toucan-400" : "opacity-60"}`}>
        <span class={`h-1.5 w-1.5 rounded-full ${s().running ? "bg-toucan-400 shadow-[0_0_8px_rgb(251_142_55_/_0.7)]" : "bg-ink-200/60"}`} />
        {s().running ? `127.0.0.1:${s().port}` : t("sb.proxyStopped")}
      </span>
      <span class="opacity-75 mono">{t("sb.flows")}: <span class="text-cobalt-400 font-medium">{flowsStore.flowsView().length}</span></span>
      <span class="opacity-75 mono">{t("sb.ca")}: <span class={s().caInstalled ? "text-emerald-400 font-medium" : "text-amber-400 font-medium"}>{s().caInstalled ? t("sb.caTrusted") : t("sb.caNotInstalled")}</span></span>
      <span class="opacity-75 mono">{t("sb.sysProxy")}: <span class={s().systemProxyOn ? "text-emerald-400 font-medium" : "opacity-60"}>{s().systemProxyOn ? t("sb.on") : t("sb.off")}</span></span>
      <div class="flex-1" />

      <Show when={u.state() === "downloading"}>
        <span class="opacity-70 mono">
          {t("updater.downloading")} {Math.round(u.progress() * 100)}%
        </span>
      </Show>
      <Show when={u.state() === "ready"}>
        <button
          onClick={() => u.restart()}
          title={t("updater.restartTitle")}
          class="mono text-toucan-400 hover:underline"
        >
          ↻ {t("updater.ready")} v{u.version()} — {t("updater.restart")}
        </button>
      </Show>

      <span class="opacity-50">{t("sb.tagline")}</span>
    </footer>
  );
}
