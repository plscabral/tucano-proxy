import { useEffect, useRef } from "react";
import type { FindController, FindHostProps } from "./FindBar";
import { findAndMark, setCurrent as setCurrentMark, unmark, FIND_CSS } from "@/lib/markFind";

// Renders captured HTML inside a Shadow DOM in the parent document and exposes
// a FindController so the parent can render a unified FindBar.
export default function ShadowPreview({ html, onFindMount, onFindUnmount, onFindState }: { html: string } & FindHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const marksRef = useRef<HTMLElement[]>([]);
  const queryRef = useRef("");
  const currentRef = useRef(0);
  const hoveredRef = useRef(false);
  const onFindStateRef = useRef(onFindState);
  onFindStateRef.current = onFindState;

  const sanitize = (raw: string): DocumentFragment => {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    doc.querySelectorAll("script,iframe,object,embed,meta[http-equiv]").forEach((el) => el.remove());
    doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim().toLowerCase();
        if (n.startsWith("on")) el.removeAttribute(attr.name);
        else if ((n === "href" || n === "src" || n === "xlink:href") && v.startsWith("javascript:")) {
          el.removeAttribute(attr.name);
        }
      }
    });
    const frag = document.createDocumentFragment();
    Array.from(doc.head.children).forEach((c) => {
      if (c.tagName === "LINK") {
        const rel = (c.getAttribute("rel") || "").toLowerCase();
        if (rel !== "stylesheet" && rel !== "icon") return;
      }
      frag.appendChild(c.cloneNode(true));
    });
    Array.from(doc.body.childNodes).forEach((c) => frag.appendChild(c.cloneNode(true)));
    return frag;
  };

  const emitState = () => onFindStateRef.current?.({ count: marksRef.current.length, current: currentRef.current });
  const scrollToCurrent = () => {
    const idx = currentRef.current - 1;
    const m = marksRef.current[idx];
    if (idx < 0 || !m) return;
    m.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const apply = () => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    unmark(shadow as unknown as HTMLElement);
    if (!queryRef.current) { marksRef.current = []; currentRef.current = 0; emitState(); return; }
    marksRef.current = findAndMark(shadow as unknown as HTMLElement, queryRef.current, document).marks;
    currentRef.current = marksRef.current.length > 0 ? 1 : 0;
    setCurrentMark(marksRef.current, currentRef.current - 1);
    scrollToCurrent();
    emitState();
  };

  const controllerRef = useRef<FindController | undefined>(undefined);
  if (!controllerRef.current) {
    controllerRef.current = {
      setQuery: (q) => { queryRef.current = q; apply(); },
      step: (dir) => {
        const marks = marksRef.current;
        if (marks.length === 0) return;
        let next = currentRef.current + dir;
        if (next < 1) next = marks.length;
        if (next > marks.length) next = 1;
        currentRef.current = next;
        setCurrentMark(marks, next - 1);
        scrollToCurrent();
        emitState();
      },
      close: () => { queryRef.current = ""; apply(); },
    };
  }

  // (Re)render the shadow content when the html changes.
  useEffect(() => {
    const h = hostRef.current;
    if (!h) return;
    if (!shadowRef.current) shadowRef.current = h.attachShadow({ mode: "open" });
    const shadow = shadowRef.current;
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
    const style = document.createElement("style");
    style.textContent =
      `:host { all: initial; display: block; height: 100%; overflow: auto; background: #fff; color: #111; font: 14px system-ui, sans-serif; }` +
      `* { box-sizing: border-box; }` + FIND_CSS;
    shadow.appendChild(style);
    shadow.appendChild(sanitize(html));
    if (queryRef.current) apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  useEffect(() => {
    onFindMount?.(controllerRef.current!);
    return () => onFindUnmount?.();
  }, [onFindMount, onFindUnmount]);

  // Keep Cmd+A → select-all-shadow behavior (Cmd+F is owned by the parent).
  useEffect(() => {
    const isTextField = (el: Element | null) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
    };
    const selectAllShadow = () => {
      const shadow = shadowRef.current;
      if (!shadow) return;
      const walker = document.createTreeWalker(shadow as unknown as Node, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest("script,style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let first: Text | null = null;
      let last: Text | null = null;
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (!first) first = n as Text;
        last = n as Text;
      }
      if (!first || !last) return;
      const sel = (shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.() || window.getSelection();
      if (!sel) return;
      try {
        sel.setBaseAndExtent(first, 0, last, (last.nodeValue || "").length);
      } catch {
        const r = document.createRange();
        r.setStart(first, 0);
        r.setEnd(last, (last.nodeValue || "").length);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    };
    const onWindowKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() === "a" && hoveredRef.current) {
        const target = e.target as Element | null;
        if (isTextField(target) || isTextField(document.activeElement)) return;
        e.preventDefault();
        e.stopPropagation();
        selectAllShadow();
      }
    };
    window.addEventListener("keydown", onWindowKey, true);
    return () => window.removeEventListener("keydown", onWindowKey, true);
  }, []);

  return (
    <div
      className="w-full h-full overflow-auto bg-white"
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
    >
      <div ref={hostRef} className="min-h-full" />
    </div>
  );
}
