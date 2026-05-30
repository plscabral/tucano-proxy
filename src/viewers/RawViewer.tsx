import RawEditor from "./RawEditor";
import { useFindShell } from "@/components/useFindShell";
import FindBar from "@/components/FindBar";
import { t } from "@/lib/i18n";

export default function RawViewer({ text, lang, wrap }: { text: string; lang: "xml" | "html" | "raw"; wrap?: boolean }) {
  const { findHostProps, findBarProps, rootProps } = useFindShell({ placeholder: t("find.sourcePlaceholder") });
  return (
    <div {...rootProps} className="h-full flex flex-col">
      <FindBar {...findBarProps} />
      <div className="flex-1 min-h-0">
        <RawEditor text={text} lang={lang} wrap={wrap} {...findHostProps} />
      </div>
    </div>
  );
}
