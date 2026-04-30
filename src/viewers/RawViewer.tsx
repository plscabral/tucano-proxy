import { createEffect, onCleanup } from "solid-js";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { theme } from "../stores/theme";
import { cmTheme } from "../lib/cmTheme";

export default function RawViewer(props: { text: string; lang: "xml" | "html" | "raw" }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  createEffect(() => {
    const ext = props.lang === "xml" ? [xml()] : props.lang === "html" ? [html()] : [];
    view?.destroy();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          lineNumbers(),
          ...ext,
          ...cmTheme(theme()),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
        ],
      }),
    });
  });
  onCleanup(() => view?.destroy());
  return <div ref={host} class="h-full" />;
}
