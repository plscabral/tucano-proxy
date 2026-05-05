import { createSignal, onCleanup, onMount } from "solid-js";
import FindBar, { type FindController, type FindHostProps, type FindState } from "./FindBar";

// Wires up a viewer-level find experience: a single FindController is bound
// to the currently mounted child (preview or source), Cmd+F focused inside
// the viewer opens the bar, and FindBar renders above the content.
export function useFindShell(opts?: { placeholder?: string }) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [state, setState] = createSignal<FindState>({ count: 0, current: 0 });
  let rootEl!: HTMLDivElement;
  let inputRef: HTMLInputElement | undefined;
  let controller: FindController | null = null;

  const findHostProps: FindHostProps = {
    onFindMount: (c) => {
      controller = c;
      // If the bar is already open with a query (e.g. user switched tabs),
      // reapply it to the new child so highlights persist.
      if (open() && query()) c.setQuery(query());
    },
    onFindUnmount: () => { controller = null; setState({ count: 0, current: 0 }); },
    onFindState: (s) => setState(s),
  };

  const openBar = () => {
    setOpen(true);
    requestAnimationFrame(() => { inputRef?.focus(); inputRef?.select(); });
    if (query()) controller?.setQuery(query());
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    controller?.close();
  };
  const onInput = (q: string) => { setQuery(q); controller?.setQuery(q); };
  const next = () => controller?.step(1);
  const prev = () => controller?.step(-1);

  let hovered = false;
  const onMouseEnter = () => { hovered = true; };
  const onMouseLeave = () => { hovered = false; };

  const onWindowKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
    if (!rootEl) return;
    const ae = document.activeElement as Node | null;
    const target = e.target as Node | null;
    const focusedInside = !!ae && rootEl.contains(ae);
    const targetInside = !!target && rootEl.contains(target);
    if (!focusedInside && !targetInside && !hovered) return;
    e.preventDefault();
    e.stopPropagation();
    openBar();
  };
  onMount(() => window.addEventListener("keydown", onWindowKey, true));
  onCleanup(() => window.removeEventListener("keydown", onWindowKey, true));

  const FindRow = () => (
    <FindBar
      open={open()}
      query={query()}
      count={state().count}
      current={state().current}
      placeholder={opts?.placeholder}
      onInput={onInput}
      onNext={next}
      onPrev={prev}
      onClose={close}
      inputRef={(el) => (inputRef = el)}
    />
  );

  return {
    findHostProps,
    FindRow,
    setRoot: (el: HTMLDivElement) => {
      rootEl = el;
      el.addEventListener("mouseenter", onMouseEnter);
      el.addEventListener("mouseleave", onMouseLeave);
    },
    openBar,
  };
}
