import { createEffect, onCleanup } from "solid-js";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldGutter } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { defaultKeymap } from "@codemirror/commands";
import { searchPanel } from "../lib/cmSearchPanel";
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
          EditorState.readOnly.of(true),
          search({ top: true, createPanel: searchPanel }),
          Prec.highest(keymap.of([...searchKeymap, ...defaultKeymap])),
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
