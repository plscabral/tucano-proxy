import { createEffect, onCleanup } from "solid-js";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { defaultKeymap } from "@codemirror/commands";
import { searchPanel } from "../lib/cmSearchPanel";
import { theme } from "../stores/theme";
import { cmTheme } from "../lib/cmTheme";

export default function RawViewer(props: {
  text: string;
  lang: "xml" | "html" | "raw";
  wrap?: boolean;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  createEffect(() => {
    const ext = props.lang === "xml" ? [xml()] : props.lang === "html" ? [html()] : [];
    const wrapExt = props.wrap === false ? [] : [EditorView.lineWrapping];
    view?.destroy();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          lineNumbers(),
          ...ext,
          ...cmTheme(theme()),
          EditorState.readOnly.of(true),
          search({ top: true, createPanel: searchPanel }),
          Prec.highest(keymap.of([...searchKeymap, ...defaultKeymap])),
          ...wrapExt,
        ],
      }),
    });
  });
  onCleanup(() => view?.destroy());
  const onTcnFind = () => { if (view) { view.focus(); openSearchPanel(view); } };
  return (
    <div
      ref={(el) => { host = el; el.addEventListener("tcn-find", onTcnFind as EventListener); }}
      data-cm-find-host
      class="h-full"
    />
  );
}
