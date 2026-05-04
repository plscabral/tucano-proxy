import type { EditorView, Panel } from "@codemirror/view";
import {
  SearchQuery, setSearchQuery, getSearchQuery,
  findNext, findPrevious, closeSearchPanel,
} from "@codemirror/search";

// Minimal find bar that mimics native browser/IDE search affordances.
// Replace is intentionally absent — this is a read-only viewer.
export function searchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "tcn-find";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Find in source";
  input.className = "tcn-find-input";
  input.spellcheck = false;
  // Seed from existing query so reopening preserves the term.
  const existing = getSearchQuery(view.state);
  if (existing.search) input.value = existing.search;

  const count = document.createElement("span");
  count.className = "tcn-find-count";

  const mkBtn = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "tcn-find-btn";
    b.title = title;
    b.innerHTML = label;
    b.tabIndex = -1;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  };

  const updateCount = () => {
    const q = getSearchQuery(view.state);
    if (!q.search) { count.textContent = ""; return; }
    try {
      const head = view.state.selection.main.head;
      const cursor = q.getCursor(view.state.doc);
      let total = 0;
      let cur = 0;
      while (!cursor.next().done) {
        total++;
        const m = cursor.value as { from: number; to: number };
        if (!cur && m.from <= head && head <= m.to) cur = total;
      }
      count.textContent = total === 0 ? "0" : `${cur || 1}/${total}`;
    } catch { count.textContent = ""; }
  };

  const apply = () => {
    const q = new SearchQuery({
      search: input.value,
      caseSensitive: false,
      regexp: false,
      wholeWord: false,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
    updateCount();
  };

  input.addEventListener("input", apply);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
      if (e.shiftKey) findPrevious(view); else findNext(view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });

  const prevBtn = mkBtn(
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
    "Previous (Shift+Enter)",
    () => { apply(); findPrevious(view); },
  );
  const nextBtn = mkBtn(
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    "Next (Enter)",
    () => { apply(); findNext(view); },
  );
  const closeBtn = mkBtn(
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    "Close (Esc)",
    () => { closeSearchPanel(view); view.focus(); },
  );

  dom.append(input, count, prevBtn, nextBtn, closeBtn);

  return {
    dom,
    top: true,
    mount() {
      requestAnimationFrame(() => { input.focus(); input.select(); });
      updateCount();
    },
    update() { updateCount(); },
  };
}
