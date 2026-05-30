import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const darkBase = EditorView.theme({
  "&": { color: "#E6E8EE", backgroundColor: "transparent", height: "100%", fontSize: "12px" },
  ".cm-content": { caretColor: "#6A57E0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#6A57E0" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(106,87,224,0.20)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "#525F88", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(106,87,224,0.07)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(106,87,224,0.10)", color: "#9583E7" },
  ".cm-foldPlaceholder": { color: "#9583E7", backgroundColor: "transparent", border: "none" },
}, { dark: true });

const lightBase = EditorView.theme({
  "&": { color: "#0C142E", backgroundColor: "transparent", height: "100%", fontSize: "12px" },
  ".cm-content": { caretColor: "#6A57E0" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(106,87,224,0.18)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "#8C95B0", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(106,87,224,0.07)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(106,87,224,0.10)", color: "#4633BE" },
}, { dark: false });

const darkHl = HighlightStyle.define([
  { tag: t.keyword, color: "#F99245" },
  { tag: [t.string, t.special(t.string)], color: "#FCC489" },
  { tag: t.number, color: "#7DD3FC" },
  { tag: t.bool, color: "#F472B6" },
  { tag: t.null, color: "#F472B6" },
  { tag: [t.propertyName, t.attributeName], color: "#93C5FD" },
  { tag: [t.tagName], color: "#F99245" },
  { tag: t.comment, color: "#525F88", fontStyle: "italic" },
  { tag: t.operator, color: "#94A3B8" },
  { tag: t.punctuation, color: "#94A3B8" },
]);

const lightHl = HighlightStyle.define([
  { tag: t.keyword, color: "#A24808" },
  { tag: [t.string, t.special(t.string)], color: "#0F766E" },
  { tag: t.number, color: "#1D4ED8" },
  { tag: t.bool, color: "#BE185D" },
  { tag: t.null, color: "#BE185D" },
  { tag: [t.propertyName, t.attributeName], color: "#1E3A8A" },
  { tag: [t.tagName], color: "#A24808" },
  { tag: t.comment, color: "#64748B", fontStyle: "italic" },
  { tag: t.operator, color: "#475569" },
  { tag: t.punctuation, color: "#475569" },
]);

export function cmTheme(mode: "dark" | "light") {
  return mode === "dark"
    ? [darkBase, syntaxHighlighting(darkHl)]
    : [lightBase, syntaxHighlighting(lightHl)];
}
