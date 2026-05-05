import RawEditor from "./RawEditor";
import { useFindShell } from "../components/useFindShell";
import { t } from "../lib/i18n";

export default function RawViewer(props: { text: string; lang: "xml" | "html" | "raw"; wrap?: boolean }) {
  const { findHostProps, FindRow, setRoot } = useFindShell({ placeholder: t("find.sourcePlaceholder") });
  return (
    <div ref={setRoot} class="h-full flex flex-col">
      <FindRow />
      <div class="flex-1 min-h-0">
        <RawEditor text={props.text} lang={props.lang} wrap={props.wrap} {...findHostProps} />
      </div>
    </div>
  );
}
