import { useEffect, useRef } from "react";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldGutter } from "@codemirror/language";
import { SearchQuery, setSearchQuery, findNext, findPrevious, search, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { hiddenSearchPanel } from "@/lib/cmHiddenPanel";
import { defaultKeymap } from "@codemirror/commands";
import { useEffectiveTheme } from "@/stores/theme";
import { cmTheme } from "@/lib/cmTheme";
import type { FindController, FindHostProps } from "@/components/FindBar";

export default function JsonEditor({ text, onFindMount, onFindUnmount, onFindState }: { text: string } & FindHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const queryRef = useRef("");
  const onFindStateRef = useRef(onFindState);
  onFindStateRef.current = onFindState;
  const theme = useEffectiveTheme();

  const controllerRef = useRef<FindController>();
  if (!controllerRef.current) {
    const count = () => {
      const view = viewRef.current, query = queryRef.current;
      if (!view || !query) return 0;
      const q = new SearchQuery({ search: query, caseSensitive: false });
      let total = 0;
      try { const cursor = q.getCursor(view.state.doc); while (!cursor.next().done) total++; } catch {}
      return total;
    };
    const idx = () => {
      const view = viewRef.current, query = queryRef.current;
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
    const emit = () => onFindStateRef.current?.({ count: count(), current: idx() });
    controllerRef.current = {
      setQuery: (q) => {
        queryRef.current = q;
        const view = viewRef.current;
        if (!view) return;
        openSearchPanel(view);
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })) });
        if (q) findNext(view);
        emit();
      },
      step: (dir) => {
        const view = viewRef.current;
        if (!view) return;
        if (dir === 1) findNext(view); else findPrevious(view);
        emit();
      },
      close: () => {
        queryRef.current = "";
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
        closeSearchPanel(view);
        emit();
      },
    };
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: pretty,
        extensions: [
          lineNumbers(),
          foldGutter(),
          json(),
          ...cmTheme(theme),
          EditorState.readOnly.of(true),
          search({ top: true, createPanel: hiddenSearchPanel }),
          Prec.highest(keymap.of(defaultKeymap)),
        ],
      }),
    });
    viewRef.current = view;
    if (queryRef.current) controllerRef.current!.setQuery(queryRef.current);
    return () => { view.destroy(); viewRef.current = null; };
  }, [text, theme]);

  useEffect(() => {
    onFindMount?.(controllerRef.current!);
    return () => onFindUnmount?.();
  }, [onFindMount, onFindUnmount]);

  return <div ref={hostRef} className="h-full" />;
}
