import { createEffect, onCleanup } from "solid-js";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldGutter } from "@codemirror/language";
import { theme } from "../stores/theme";
import { cmTheme } from "../lib/cmTheme";

export default function JsonViewer(props: { text: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  createEffect(() => {
    let pretty = props.text;
    try { pretty = JSON.stringify(JSON.parse(props.text), null, 2); } catch {}
    view?.destroy();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: pretty,
        extensions: [
          lineNumbers(),
          foldGutter(),
          json(),
          ...cmTheme(theme()),
          EditorView.editable.of(false),
        ],
      }),
    });
  });
  onCleanup(() => view?.destroy());
  return <div ref={host} class="h-full" />;
}
