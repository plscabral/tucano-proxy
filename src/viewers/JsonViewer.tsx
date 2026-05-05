import JsonEditor from "./JsonEditor";
import { useFindShell } from "../components/useFindShell";
import { t } from "../lib/i18n";

export default function JsonViewer(props: { text: string }) {
  const { findHostProps, FindRow, setRoot } = useFindShell({ placeholder: t("find.sourcePlaceholder") });
  return (
    <div ref={setRoot} class="h-full flex flex-col">
      <FindRow />
      <div class="flex-1 min-h-0">
        <JsonEditor text={props.text} {...findHostProps} />
      </div>
    </div>
  );
}
