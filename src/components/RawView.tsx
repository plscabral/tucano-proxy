import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";

export default function RawView({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div className="relative h-full">
      <button
        onClick={copy}
        title={t("ins.copy") || "Copy"}
        className="absolute top-2 right-2 z-10 h-7 px-2.5 rounded-md text-[11px] flex items-center gap-1.5 appearance-none bg-background text-foreground border border-input hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background transition-colors"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? t("ins.copied") || "Copied" : t("ins.copy") || "Copy"}
      </button>
      <pre
        tabIndex={0}
        data-inspector="true"
        onMouseDown={(e) => (e.currentTarget as HTMLElement).focus()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            e.stopPropagation();
            const el = e.currentTarget as HTMLElement;
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            e.preventDefault();
          }
        }}
        className="mono text-[11px] leading-relaxed px-3 py-3 whitespace-pre-wrap [overflow-wrap:anywhere] select-text outline-none h-full"
      >{text}</pre>
    </div>
  );
}
