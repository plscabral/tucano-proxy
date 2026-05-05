import { Copy, Check } from "lucide-solid";
import { createSignal } from "solid-js";
import { t } from "../lib/i18n";

export default function RawView(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div class="relative h-full">
      <button
        onClick={copy}
        title={t("ins.copy") || "Copy"}
        class="absolute top-2 right-2 z-10 h-7 px-2.5 rounded-md text-[11px] flex items-center gap-1.5 bg-white/80 dark:bg-ink-500/80 backdrop-blur border border-ink-100 dark:border-ink-400/30 hover:bg-toucan-400/10 hover:text-toucan-400 transition"
      >
        {copied() ? <Check size={11} /> : <Copy size={11} />}
        {copied() ? t("ins.copied") || "Copied" : t("ins.copy") || "Copy"}
      </button>
      <pre class="mono text-[11px] leading-relaxed px-3 py-3 whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
        {props.text}
      </pre>
    </div>
  );
}
