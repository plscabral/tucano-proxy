import type { Flow } from "@/lib/types";
import { t } from "@/lib/i18n";

export default function TimingView({ flow }: { flow: Flow }) {
  const f = flow;
  const total = f.durationMs ?? 0;
  return (
    <div className="p-4 text-sm space-y-3">
      <div className="mono text-xs opacity-60">{t("tim.total")}: {total}ms</div>
      <div className="h-3 rounded bg-ink-100 dark:bg-ink-400/30 overflow-hidden">
        <div className="h-full bg-toucan-400" style={{ width: total > 0 ? "100%" : "0%" }} />
      </div>
      <table className="text-xs mono w-full">
        <tbody>
          <tr><td className="py-1 opacity-60 w-32">{t("tim.started")}</td><td>{new Date(f.startedAt).toISOString()}</td></tr>
          <tr><td className="py-1 opacity-60">{t("tim.ended")}</td><td>{f.endedAt ? new Date(f.endedAt).toISOString() : "—"}</td></tr>
          <tr><td className="py-1 opacity-60">{t("tim.duration")}</td><td>{total}ms</td></tr>
          <tr><td className="py-1 opacity-60">{t("tim.reqSize")}</td><td>{f.reqSize} bytes</td></tr>
          <tr><td className="py-1 opacity-60">{t("tim.resSize")}</td><td>{f.resSize} bytes</td></tr>
          <tr><td className="py-1 opacity-60">{t("tim.protocol")}</td><td>{f.httpVersion}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
