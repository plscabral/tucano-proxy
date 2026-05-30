import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FindController, FindHostProps, FindState, FindBarProps } from "./FindBar";

// Wires up a viewer-level find experience: a single FindController is bound to
// the currently mounted child (preview or source), Cmd+F focused inside the
// viewer opens the bar, and FindBar renders above the content.
export function useFindShell(opts?: { placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<FindState>({ count: 0, current: 0 });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<FindController | null>(null);
  const hoveredRef = useRef(false);
  const openRef = useRef(open); openRef.current = open;
  const queryRef = useRef(query); queryRef.current = query;

  const findHostProps: FindHostProps = useMemo(() => ({
    onFindMount: (c) => {
      controllerRef.current = c;
      // If the bar is already open with a query (e.g. tab switch), reapply.
      if (openRef.current && queryRef.current) c.setQuery(queryRef.current);
    },
    onFindUnmount: () => { controllerRef.current = null; setState({ count: 0, current: 0 }); },
    onFindState: (s) => setState(s),
  }), []);

  const openBar = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    if (queryRef.current) controllerRef.current?.setQuery(queryRef.current);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    controllerRef.current?.close();
  }, []);
  const onInput = useCallback((q: string) => { setQuery(q); controllerRef.current?.setQuery(q); }, []);
  const next = useCallback(() => controllerRef.current?.step(1), []);
  const prev = useCallback(() => controllerRef.current?.step(-1), []);

  useEffect(() => {
    const onWindowKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "f") return;
      const root = rootRef.current;
      if (!root) return;
      const ae = document.activeElement as Node | null;
      const target = e.target as Node | null;
      const focusedInside = !!ae && root.contains(ae);
      const targetInside = !!target && root.contains(target);
      if (!focusedInside && !targetInside && !hoveredRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      openBar();
    };
    // Cross-component handoff from the global Find All bar.
    const onFindAll = (e: Event) => {
      const q = (e as CustomEvent<{ query: string }>).detail?.query ?? "";
      if (!q) return;
      setOpen(true);
      setQuery(q);
      controllerRef.current?.setQuery(q);
    };
    window.addEventListener("keydown", onWindowKey, true);
    window.addEventListener("tucano:findAll", onFindAll);
    return () => {
      window.removeEventListener("keydown", onWindowKey, true);
      window.removeEventListener("tucano:findAll", onFindAll);
    };
  }, [openBar]);

  const rootProps: {
    ref: (el: HTMLDivElement | null) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  } = {
    ref: (el) => { rootRef.current = el; },
    onMouseEnter: () => { hoveredRef.current = true; },
    onMouseLeave: () => { hoveredRef.current = false; },
  };

  const findBarProps: FindBarProps = {
    open,
    query,
    count: state.count,
    current: state.current,
    placeholder: opts?.placeholder,
    onInput,
    onNext: next,
    onPrev: prev,
    onClose: close,
    inputRef: (el) => { inputRef.current = el; },
  };

  return { findHostProps, findBarProps, rootProps, openBar };
}
