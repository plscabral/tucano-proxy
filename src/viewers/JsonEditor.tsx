import { createEffect, onCleanup, onMount } from "solid-js";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldGutter } from "@codemirror/language";
import { SearchQuery, setSearchQuery, findNext, findPrevious, search, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { hiddenSearchPanel } from "../lib/cmHiddenPanel";
import { defaultKeymap } from "@codemirror/commands";
import { theme } from "../stores/theme";
import { cmTheme } from "../lib/cmTheme";
import type { FindController, FindHostProps } from "../components/FindBar";

export default function JsonEditor(props: { text: string } & FindHostProps) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let query = "";

  const count = () => {
    if (!view || !query) return 0;
    const q = new SearchQuery({ search: query, caseSensitive: false });
    let total = 0;
    try {
      const cursor = q.getCursor(view.state.doc);
      while (!cursor.next().done) total++;
    } catch {}
    return total;
  };
  const idx = () => {
    if (!view || !query) return 0;
    const q = new SearchQuery({ search: query, caseSensitive: false });
    const head = view.state.selection.main.head;
    let i = 0, cur = 0;
    try {
      const cursor = q.getCursor(view.state.doc);
      let res = cursor.next();
      while (!res.done) {
        i++;
        const m = res.value as { from: number; to: number };
        if (!cur && m.from <= head && head <= m.to) cur = i;
        res = cursor.next();
      }
    } catch {}
    return cur || (i > 0 ? 1 : 0);
  };
  const emit = () => props.onFindState?.({ count: count(), current: idx() });

  const controller: FindController = {
    setQuery: (q) => {
      query = q;
      if (!view) return;
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })) });
      if (q) findNext(view);
      emit();
    },
    step: (dir) => {
      if (!view) return;
      if (dir === 1) findNext(view); else findPrevious(view);
      emit();
    },
    close: () => {
      query = "";
      if (!view) return;
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      closeSearchPanel(view);
      emit();
    },
  };

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
          search({ top: true, createPanel: hiddenSearchPanel }),
          Prec.highest(keymap.of(defaultKeymap)),
        ],
      }),
    });
    if (query) controller.setQuery(query);
  });
  onCleanup(() => view?.destroy());

  onMount(() => props.onFindMount?.(controller));
  onCleanup(() => props.onFindUnmount?.());

  return <div ref={(el) => { host = el; }} class="h-full" />;
}
