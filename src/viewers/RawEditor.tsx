import { createEffect, onCleanup, onMount } from "solid-js";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { SearchQuery, setSearchQuery, findNext, findPrevious, search, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { hiddenSearchPanel } from "../lib/cmHiddenPanel";
import { defaultKeymap } from "@codemirror/commands";
import { theme } from "../stores/theme";
import { cmTheme } from "../lib/cmTheme";
import type { FindController, FindHostProps } from "../components/FindBar";

type Props = {
  text: string;
  lang: "xml" | "html" | "raw";
  wrap?: boolean;
} & FindHostProps;

export default function RawEditor(props: Props) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let query = "";

  const countMatches = () => {
    if (!view || !query) return 0;
    const q = new SearchQuery({ search: query, caseSensitive: false, regexp: false, wholeWord: false });
    let total = 0;
    try {
      const cursor = q.getCursor(view.state.doc);
      while (!cursor.next().done) total++;
    } catch {}
    return total;
  };

  const currentIndex = () => {
    if (!view || !query) return 0;
    const q = new SearchQuery({ search: query, caseSensitive: false });
    const head = view.state.selection.main.head;
    let i = 0;
    let cur = 0;
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

  const emit = () => props.onFindState?.({ count: countMatches(), current: currentIndex() });

  const controller: FindController = {
    setQuery: (q) => {
      query = q;
      if (!view) return;
      // openSearchPanel flips searchState.panel so cm-searchMatch
      // decorations actually paint. The panel itself is hidden via
      // hiddenSearchPanel so no CM-native UI ever shows.
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
          // The search extension provides the underlying search state field
          // and match highlighting. We never call openSearchPanel, so its
          // default panel UI never appears — our parent renders FindBar.
          search({ top: true, createPanel: hiddenSearchPanel }),
          Prec.highest(keymap.of(defaultKeymap)),
          ...wrapExt,
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
