import { createSignal, onCleanup, Show } from "solid-js";

type Props = { srcdoc?: string; src?: string };

// Iframe preview with an in-app find bar. We use sandbox="allow-same-origin"
// (no allow-scripts) so the parent can walk the iframe's DOM to highlight
// matches, while still blocking any script execution from the captured page.
export default function IframePreview(props: Props) {
  let iframe!: HTMLIFrameElement;
  let containerEl!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [count, setCount] = createSignal(0);
  const [current, setCurrent] = createSignal(0);
  let inputRef!: HTMLInputElement;

  const doc = () => iframe?.contentDocument ?? null;

  // Matches are kept as DOM Ranges so they can span multiple text nodes /
  // elements (e.g. <span>Versao</span> 2.2). Highlighting uses the CSS
  // Custom Highlight API on the iframe's window.
  let ranges: Range[] = [];

  const clearMarks = () => {
    const d = doc();
    if (!d) return;
    const w = d.defaultView as any;
    if (w?.CSS?.highlights) {
      w.CSS.highlights.delete("tcn-hl");
      w.CSS.highlights.delete("tcn-hl-cur");
    }
    ranges = [];
  };

  const ensureStyle = () => {
    const d = doc();
    if (!d?.head || d.getElementById("tcn-find-style")) return;
    const s = d.createElement("style");
    s.id = "tcn-find-style";
    s.textContent =
      `::highlight(tcn-hl) { background: rgba(251,146,60,0.35); }` +
      `::highlight(tcn-hl-cur) { background: #FB923C; color: #0F182E; }`;
    d.head.appendChild(s);
  };

  const apply = () => {
    const d = doc();
    if (!d?.body) { setCount(0); setCurrent(0); return; }
    clearMarks();
    const q = query();
    if (!q) { setCount(0); setCurrent(0); return; }
    ensureStyle();
    const lc = q.toLowerCase();
    // Build a flat string from all visible text nodes plus a map back to
    // (node, offset) so matches that cross element boundaries still work.
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("script,style,noscript") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    const offsets: number[] = []; // start index of each node in flat string
    let flat = "";
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      const t = cur as Text;
      offsets.push(flat.length);
      nodes.push(t);
      flat += t.nodeValue || "";
    }
    const flatLower = flat.toLowerCase();
    const found: Range[] = [];
    let from = 0;
    while (true) {
      const idx = flatLower.indexOf(lc, from);
      if (idx < 0) break;
      const end = idx + lc.length;
      // Locate which text nodes contain idx and end.
      const findNode = (pos: number): { node: Text; off: number } | null => {
        // Binary search via offsets array.
        let lo = 0, hi = nodes.length - 1, res = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (offsets[mid] <= pos) { res = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (res < 0) return null;
        return { node: nodes[res], off: pos - offsets[res] };
      };
      const a = findNode(idx);
      const b = findNode(end - 1);
      if (a && b) {
        const r = d.createRange();
        r.setStart(a.node, a.off);
        r.setEnd(b.node, b.off + 1);
        found.push(r);
      }
      from = end;
    }
    ranges = found;
    setCount(found.length);
    setCurrent(found.length > 0 ? 1 : 0);
    paintHighlights();
    focusCurrent();
  };

  const paintHighlights = () => {
    const d = doc();
    if (!d) return;
    const w = d.defaultView as any;
    if (!w?.CSS?.highlights || typeof w.Highlight === "undefined") return;
    w.CSS.highlights.delete("tcn-hl");
    w.CSS.highlights.delete("tcn-hl-cur");
    const idx = current() - 1;
    const others = ranges.filter((_, i) => i !== idx);
    if (others.length) w.CSS.highlights.set("tcn-hl", new w.Highlight(...others));
    if (idx >= 0 && ranges[idx]) w.CSS.highlights.set("tcn-hl-cur", new w.Highlight(ranges[idx]));
  };

  const focusCurrent = () => {
    paintHighlights();
    const idx = current() - 1;
    if (idx < 0 || !ranges[idx]) return;
    const r = ranges[idx];
    const startEl = (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer as Element);
    startEl?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  const step = (dir: 1 | -1) => {
    if (count() === 0) return;
    let next = current() + dir;
    if (next < 1) next = count();
    if (next > count()) next = 1;
    setCurrent(next);
    focusCurrent();
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    clearMarks();
    iframe?.focus();
  };

  const openBar = () => {
    setOpen(true);
    requestAnimationFrame(() => { inputRef?.focus(); inputRef?.select(); });
  };
  const onWindowKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
    e.preventDefault();
    e.stopPropagation();
    openBar();
  };
  window.addEventListener("keydown", onWindowKey, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKey, true));

  const onIframeKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      openBar();
    }
  };

  // Re-run when the doc loads (srcdoc changes recreate it). Attach a
  // keydown listener inside the iframe document too — when focus lands
  // inside the iframe (e.g. user clicked a link), the parent window never
  // sees the keystroke. Do NOT steal focus to the iframe on load: keeping
  // focus on the parent lets the parent's Cmd+F listener fire.
  // When the iframe holds focus, WKWebView swallows Cmd+F before JS sees
  // it. Keep focus on the parent: block mousedown's default focus
  // transfer on the iframe itself, and steal focus back synchronously
  // from any element inside the iframe document that grabs it.
  const stealFocus = () => {
    try { iframe.blur(); (iframe.contentDocument?.activeElement as HTMLElement | null)?.blur?.(); } catch {}
    try { window.focus(); document.body?.focus?.(); } catch {}
  };
  const onLoad = () => {
    const d = iframe.contentDocument;
    if (d) {
      d.removeEventListener("keydown", onIframeKey, true);
      d.addEventListener("keydown", onIframeKey, true);
      d.removeEventListener("focusin", stealFocus, true);
      d.addEventListener("focusin", stealFocus, true);
      d.removeEventListener("mousedown", stealFocus, true);
      d.addEventListener("mousedown", stealFocus, true);
    }
    if (open() && query()) apply();
  };

  // Allow parents (e.g. a Find button in the toolbar) to open the bar.
  const onTcnFind = () => openBar();
  const setRoot = (el: HTMLDivElement) => {
    containerEl = el;
    el.addEventListener("tcn-find", onTcnFind as EventListener);
  };
  onCleanup(() => containerEl?.removeEventListener("tcn-find", onTcnFind as EventListener));

  return (
    <div
      ref={setRoot}
      data-iframe-find-host
      class="w-full h-full flex flex-col"
    >
      <Show when={open()}>
        <div class="tcn-find shrink-0">
          <input
            ref={inputRef}
            class="tcn-find-input"
            placeholder="Find in preview"
            value={query()}
            onInput={(e) => { setQuery(e.currentTarget.value); apply(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              else if (e.key === "Escape") { e.preventDefault(); close(); }
            }}
          />
          <span class="tcn-find-count">{count() === 0 ? "0" : `${current()}/${count()}`}</span>
          <button class="tcn-find-btn" title="Previous (Shift+Enter)" onClick={() => step(-1)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </button>
          <button class="tcn-find-btn" title="Next (Enter)" onClick={() => step(1)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="tcn-find-btn" title="Close (Esc)" onClick={close}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </Show>
      <div class="flex-1 min-h-0 relative">
        <iframe
          ref={iframe}
          tabindex="-1"
          class="absolute inset-0 w-full h-full border-0 bg-white"
          sandbox="allow-same-origin"
          srcdoc={props.srcdoc}
          src={props.src}
          onLoad={onLoad}
          onMouseDown={(e) => { (e.currentTarget as HTMLIFrameElement).blur(); }}
        />
      </div>
    </div>
  );
}
