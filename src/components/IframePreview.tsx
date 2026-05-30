import { useEffect, useRef } from "react";
import type { FindController, FindHostProps } from "./FindBar";
import { findAndMark, setCurrent, unmark, FIND_CSS } from "@/lib/markFind";

type Props = { srcdoc?: string; src?: string } & FindHostProps;

export default function IframePreview({ srcdoc, src, onFindMount, onFindUnmount, onFindState }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const queryRef = useRef("");
  const currentRef = useRef(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const onFindStateRef = useRef(onFindState);
  onFindStateRef.current = onFindState;

  const controllerRef = useRef<FindController | undefined>(undefined);
  if (!controllerRef.current) {
    const doc = () => iframeRef.current?.contentDocument ?? null;
    const emitState = () => onFindStateRef.current?.({ count: marksRef.current.length, current: currentRef.current });
    const ensureStyle = () => {
      const d = doc();
      if (!d?.head || d.getElementById("tcn-find-style")) return;
      const s = d.createElement("style");
      s.id = "tcn-find-style";
      s.textContent = FIND_CSS;
      d.head.appendChild(s);
    };
    const scrollToCurrent = () => {
      const idx = currentRef.current - 1;
      const m = marksRef.current[idx];
      if (idx < 0 || !m) return;
      m.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    const apply = () => {
      const d = doc();
      if (!d?.body) { marksRef.current = []; currentRef.current = 0; emitState(); return; }
      unmark(d.body);
      if (!queryRef.current) { marksRef.current = []; currentRef.current = 0; emitState(); return; }
      ensureStyle();
      marksRef.current = findAndMark(d.body, queryRef.current, d).marks;
      currentRef.current = marksRef.current.length > 0 ? 1 : 0;
      setCurrent(marksRef.current, currentRef.current - 1);
      scrollToCurrent();
      emitState();
    };
    (controllerRef as any)._apply = apply;
    controllerRef.current = {
      setQuery: (q) => { queryRef.current = q; apply(); },
      step: (dir) => {
        const marks = marksRef.current;
        if (marks.length === 0) return;
        let next = currentRef.current + dir;
        if (next < 1) next = marks.length;
        if (next > marks.length) next = 1;
        currentRef.current = next;
        setCurrent(marks, next - 1);
        scrollToCurrent();
        emitState();
      },
      close: () => { queryRef.current = ""; apply(); },
    };
  }

  useEffect(() => {
    onFindMount?.(controllerRef.current!);
    return () => onFindUnmount?.();
  }, [onFindMount, onFindUnmount]);

  const stealFocus = () => {
    const iframe = iframeRef.current;
    try { iframe?.blur(); (iframe?.contentDocument?.activeElement as HTMLElement | null)?.blur?.(); } catch {}
    try { window.focus(); document.body?.focus?.(); } catch {}
  };
  const onLoad = () => {
    const d = iframeRef.current?.contentDocument;
    if (d) {
      d.removeEventListener("focusin", stealFocus, true);
      d.addEventListener("focusin", stealFocus, true);
      d.removeEventListener("mousedown", stealFocus, true);
      d.addEventListener("mousedown", stealFocus, true);
    }
    if (queryRef.current) (controllerRef as any)._apply?.();
  };

  return (
    <iframe
      ref={iframeRef}
      tabIndex={-1}
      className="w-full h-full border-0 bg-white"
      sandbox="allow-same-origin"
      srcDoc={srcdoc}
      src={src}
      onLoad={onLoad}
      onMouseDown={(e) => { (e.currentTarget as HTMLIFrameElement).blur(); }}
    />
  );
}
