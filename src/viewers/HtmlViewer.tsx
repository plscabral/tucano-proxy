import { Search } from "lucide-react";
import RawEditor from "./RawEditor";
import ShadowPreview from "@/components/ShadowPreview";
import { useFindShell } from "@/components/useFindShell";
import FindBar from "@/components/FindBar";
import { usePreviewTab } from "./previewTab";
import { t } from "@/lib/i18n";

export default function HtmlViewer({ text, wrap }: { text: string; wrap?: boolean }) {
  const { findHostProps, findBarProps, rootProps, openBar } = useFindShell();
  const tab = usePreviewTab((s) => s.tab);
  const setTab = usePreviewTab((s) => s.setTab);

  const btn = (active: boolean) =>
    `px-2.5 h-7 rounded-lg text-[11px] mono uppercase tracking-wider transition ${
      active
        ? "bg-toucan-400 text-white font-medium"
        : "opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
    }`;

  return (
    <div {...rootProps} className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        <button onClick={() => setTab("preview")} className={btn(tab === "preview")}>{t("body.preview")}</button>
        <button onClick={() => setTab("source")} className={btn(tab === "source")}>{t("body.source")}</button>
        <button
          onClick={openBar}
          title={t("find.open") || "Find (⌘F)"}
          className="ml-auto h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition shrink-0"
        >
          <Search size={13} />
        </button>
      </div>
      <FindBar {...findBarProps} />
      <div className="flex-1 min-h-0">
        {tab === "preview"
          ? <ShadowPreview html={text} {...findHostProps} />
          : <RawEditor text={text} lang="html" wrap={wrap} {...findHostProps} />}
      </div>
    </div>
  );
}
