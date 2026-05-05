import type { EditorView, Panel } from "@codemirror/view";

// CodeMirror's search() only paints `.cm-searchMatch` decorations while a
// search panel is mounted in state. We don't want CM's own UI — our parent
// renders FindBar — but we still need the match highlights, so we register
// a zero-size hidden panel just to flip the flag.
export function hiddenSearchPanel(_view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.style.cssText = "display:none;height:0;padding:0;border:0";
  dom.setAttribute("aria-hidden", "true");
  return { dom, top: true };
}
