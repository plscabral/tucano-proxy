import type { Flow } from "../lib/types";
import { t } from "../lib/i18n";

export default function TimingView(props: { flow: Flow }) {
  const f = props.flow;
  const total = f.durationMs ?? 0;
  return (
    <div class="p-4 text-sm space-y-3">
      <div class="mono text-xs opacity-60">{t("tim.total")}: {total}ms</div>
      <div class="h-3 rounded bg-ink-100 dark:bg-ink-400/30 overflow-hidden">
        <div class="h-full bg-toucan-400" style={{ width: total > 0 ? "100%" : "0%" }} />
      </div>
      <table class="text-xs mono w-full">
        <tbody>
          <tr><td class="py-1 opacity-60 w-32">{t("tim.started")}</td><td>{new Date(f.startedAt).toISOString()}</td></tr>
          <tr><td class="py-1 opacity-60">{t("tim.ended")}</td><td>{f.endedAt ? new Date(f.endedAt).toISOString() : "—"}</td></tr>
          <tr><td class="py-1 opacity-60">{t("tim.duration")}</td><td>{total}ms</td></tr>
          <tr><td class="py-1 opacity-60">{t("tim.reqSize")}</td><td>{f.reqSize} bytes</td></tr>
          <tr><td class="py-1 opacity-60">{t("tim.resSize")}</td><td>{f.resSize} bytes</td></tr>
          <tr><td class="py-1 opacity-60">{t("tim.protocol")}</td><td>{f.httpVersion}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
