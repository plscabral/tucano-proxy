import { createSignal, createMemo, onCleanup } from "solid-js";
import { Search } from "lucide-solid";
import RawEditor from "./RawEditor";
import IframePreview from "../components/IframePreview";
import { useFindShell } from "../components/useFindShell";
import { t } from "../lib/i18n";

const [tab, setTab] = createSignal<"preview" | "source">("source");

export default function XmlViewer(props: { text: string; wrap?: boolean }) {
  const { findHostProps, FindRow, setRoot, openBar } = useFindShell();

  const btn = (active: boolean) =>
    `px-2.5 h-7 rounded-lg text-[11px] mono uppercase tracking-wider transition ${
      active
        ? "bg-toucan-400 text-ink-500 font-medium"
        : "opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
    }`;

  let lastUrl: string | null = null;
  const url = createMemo(() => {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const u = URL.createObjectURL(new Blob([props.text], { type: "application/xml" }));
    lastUrl = u;
    return u;
  });
  onCleanup(() => { if (lastUrl) URL.revokeObjectURL(lastUrl); });

  return (
    <div ref={setRoot} class="h-full flex flex-col">
      <div class="flex items-center gap-1.5 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        <button onClick={() => setTab("preview")} class={btn(tab() === "preview")}>
          {t("body.preview")}
        </button>
        <button onClick={() => setTab("source")} class={btn(tab() === "source")}>
          {t("body.source")}
        </button>
        <button
          onClick={openBar}
          title={t("find.open") || "Find (⌘F)"}
          class="ml-auto h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition shrink-0"
        >
          <Search size={13} />
        </button>
      </div>
      <FindRow />
      <div class="flex-1 min-h-0">
        {tab() === "preview" ? (
          <IframePreview src={url()} {...findHostProps} />
        ) : (
          <RawEditor text={props.text} lang="xml" wrap={props.wrap} {...findHostProps} />
        )}
      </div>
    </div>
  );
}
