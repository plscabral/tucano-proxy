import JsonEditor from "./JsonEditor";
import { useFindShell } from "@/components/useFindShell";
import FindBar from "@/components/FindBar";
import { t } from "@/lib/i18n";

export default function JsonViewer({ text }: { text: string }) {
  const { findHostProps, findBarProps, rootProps } = useFindShell({ placeholder: t("find.sourcePlaceholder") });
  return (
    <div {...rootProps} className="h-full flex flex-col">
      <FindBar {...findBarProps} />
      <div className="flex-1 min-h-0">
        <JsonEditor text={text} {...findHostProps} />
      </div>
    </div>
  );
}
