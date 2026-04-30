import { createSignal } from "solid-js";
import RawViewer from "./RawViewer";
import { t } from "../lib/i18n";

export default function HtmlViewer(props: { text: string }) {
  const [tab, setTab] = createSignal<"preview" | "source" | "rendered-tree">("preview");
  return (
    <div class="h-full flex flex-col">
      <div class="flex items-center gap-1 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        <button onClick={() => setTab("preview")}
          class={`px-2.5 h-7 rounded-lg text-[11px] mono ${tab() === "preview" ? "bg-toucan-400 text-ink-500 font-medium" : "opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}>
          {t("body.preview")}
        </button>
        <button onClick={() => setTab("source")}
          class={`px-2.5 h-7 rounded-lg text-[11px] mono ${tab() === "source" ? "bg-toucan-400 text-ink-500 font-medium" : "opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}>
          {t("body.source")}
        </button>
        <span class="ml-auto opacity-50 mono text-[11px]">{t("body.sandboxed")}</span>
      </div>
      <div class="flex-1 overflow-auto scroll-thin bg-white">
        {tab() === "preview" ? (
          <iframe class="w-full h-full border-0 bg-white" sandbox="" srcdoc={props.text} />
        ) : (
          <RawViewer text={props.text} lang="html" />
        )}
      </div>
    </div>
  );
}
