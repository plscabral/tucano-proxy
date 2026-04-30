import { flowsStore } from "../stores/flows";
import { t } from "../lib/i18n";

export default function StatusBar() {
  const s = flowsStore.status;
  return (
    <footer class="h-8 px-5 flex items-center gap-5 text-[11px] bg-ink-50/80 dark:bg-ink-600 text-ink-400 dark:text-ink-100 border-t border-ink-100 dark:border-ink-400/30">
      <span class={`mono ${s().running ? "text-toucan-400" : "opacity-60"}`}>
        ● {s().running ? `127.0.0.1:${s().port}` : t("sb.proxyStopped")}
      </span>
      <span class="opacity-60">{t("sb.flows")}: {flowsStore.flows().length}</span>
      <span class="opacity-60">{t("sb.ca")}: {s().caInstalled ? t("sb.caTrusted") : t("sb.caNotInstalled")}</span>
      <span class="opacity-60">{t("sb.sysProxy")}: {s().systemProxyOn ? t("sb.on") : t("sb.off")}</span>
      <div class="flex-1" />
      <span class="opacity-50">{t("sb.tagline")}</span>
    </footer>
  );
}
