import { onCleanup, onMount } from "solid-js";
import type { FindController, FindHostProps } from "./FindBar";
import { findAndMark, setCurrent, unmark, FIND_CSS } from "../lib/markFind";

type Props = { srcdoc?: string; src?: string } & FindHostProps;

export default function IframePreview(props: Props) {
  let iframe!: HTMLIFrameElement;
  let query = "";
  let current = 0;
  let marks: HTMLElement[] = [];

  const doc = () => iframe?.contentDocument ?? null;

  const ensureStyle = () => {
    const d = doc();
    if (!d?.head || d.getElementById("tcn-find-style")) return;
    const s = d.createElement("style");
    s.id = "tcn-find-style";
    s.textContent = FIND_CSS;
    d.head.appendChild(s);
  };

  const apply = () => {
    const d = doc();
    if (!d?.body) { marks = []; current = 0; emitState(); return; }
    unmark(d.body);
    if (!query) { marks = []; current = 0; emitState(); return; }
    ensureStyle();
    marks = findAndMark(d.body, query, d).marks;
    current = marks.length > 0 ? 1 : 0;
    setCurrent(marks, current - 1);
    scrollToCurrent();
    emitState();
  };

  const scrollToCurrent = () => {
    const idx = current - 1;
    if (idx < 0 || !marks[idx]) return;
    marks[idx].scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const emitState = () => props.onFindState?.({ count: marks.length, current });

  const controller: FindController = {
    setQuery: (q) => { query = q; apply(); },
    step: (dir) => {
      if (marks.length === 0) return;
      let next = current + dir;
      if (next < 1) next = marks.length;
      if (next > marks.length) next = 1;
      current = next;
      setCurrent(marks, current - 1);
      scrollToCurrent();
      emitState();
    },
    close: () => { query = ""; apply(); },
  };

  const stealFocus = () => {
    try { iframe.blur(); (iframe.contentDocument?.activeElement as HTMLElement | null)?.blur?.(); } catch {}
    try { window.focus(); document.body?.focus?.(); } catch {}
  };
  const onLoad = () => {
    const d = iframe.contentDocument;
    if (d) {
      d.removeEventListener("focusin", stealFocus, true);
      d.addEventListener("focusin", stealFocus, true);
      d.removeEventListener("mousedown", stealFocus, true);
      d.addEventListener("mousedown", stealFocus, true);
    }
    if (query) apply();
  };

  onMount(() => props.onFindMount?.(controller));
  onCleanup(() => props.onFindUnmount?.());

  return (
    <iframe
      ref={iframe}
      tabindex="-1"
      class="w-full h-full border-0 bg-white"
      sandbox="allow-same-origin"
      srcdoc={props.srcdoc}
      src={props.src}
      onLoad={onLoad}
      onMouseDown={(e) => { (e.currentTarget as HTMLIFrameElement).blur(); }}
    />
  );
}
