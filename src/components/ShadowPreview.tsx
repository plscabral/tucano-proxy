import { createEffect, createSignal, onCleanup, Show } from "solid-js";

// Renders captured HTML inside a Shadow DOM in the parent document.
// Unlike an iframe, the content lives in our window — Cmd+F handlers, the
// CSS Custom Highlight API, and the parent's keystrokes all reach it
// directly. Safety: parse with DOMParser and strip <script>/event-handler
// attributes / javascript: URLs so the captured page can't execute code.
export default function ShadowPreview(props: { html: string }) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  let shadow: ShadowRoot | null = null;

  // Match-tracking state mirrors IframePreview so the toolbar's find
  // button can drive both renderers identically.
  let ranges: Range[] = [];
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [count, setCount] = createSignal(0);
  const [current, setCurrent] = createSignal(0);
  let inputRef!: HTMLInputElement;

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
    // Pull in <head> styles/links so layout is preserved.
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

  createEffect(() => {
    const h = host();
    if (!h) return;
    if (!shadow) shadow = h.attachShadow({ mode: "open" });
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
    // Base styles to give shadow root a nice canvas.
    const style = document.createElement("style");
    style.textContent =
      `:host { all: initial; display: block; height: 100%; overflow: auto; background: #fff; color: #111; font: 14px system-ui, sans-serif; }` +
      `* { box-sizing: border-box; }` +
      `::highlight(tcn-hl) { background: rgba(251,146,60,0.35); }` +
      `::highlight(tcn-hl-cur) { background: #FB923C; color: #0F182E; }`;
    shadow.appendChild(style);
    shadow.appendChild(sanitize(props.html));
    if (open() && query()) apply();
  });

  onCleanup(() => {
    (window as any).CSS?.highlights?.delete?.("tcn-hl");
    (window as any).CSS?.highlights?.delete?.("tcn-hl-cur");
  });

  const apply = () => {
    if (!shadow) return;
    ranges = [];
    const q = query();
    (window as any).CSS?.highlights?.delete?.("tcn-hl");
    (window as any).CSS?.highlights?.delete?.("tcn-hl-cur");
    if (!q) { setCount(0); setCurrent(0); return; }
    const lc = q.toLowerCase();
    // Walk text nodes inside shadow, build a flat string + node offsets so
    // matches can span element boundaries.
    const walker = document.createTreeWalker(shadow as any, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("script,style,noscript") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    const offsets: number[] = [];
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
      const findNode = (pos: number) => {
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
        const r = document.createRange();
        r.setStart(a.node, a.off);
        r.setEnd(b.node, b.off + 1);
        found.push(r);
      }
      from = end;
    }
    ranges = found;
    setCount(found.length);
    setCurrent(found.length > 0 ? 1 : 0);
    paint();
    scrollToCurrent();
  };

  const paint = () => {
    const w = window as any;
    if (!w.CSS?.highlights || typeof w.Highlight === "undefined") return;
    w.CSS.highlights.delete("tcn-hl");
    w.CSS.highlights.delete("tcn-hl-cur");
    const idx = current() - 1;
    const others = ranges.filter((_, i) => i !== idx);
    if (others.length) w.CSS.highlights.set("tcn-hl", new w.Highlight(...others));
    if (idx >= 0 && ranges[idx]) w.CSS.highlights.set("tcn-hl-cur", new w.Highlight(ranges[idx]));
  };

  const scrollToCurrent = () => {
    paint();
    const idx = current() - 1;
    if (idx < 0 || !ranges[idx]) return;
    const r = ranges[idx];
    const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer as Element;
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };

  const step = (dir: 1 | -1) => {
    if (count() === 0) return;
    let next = current() + dir;
    if (next < 1) next = count();
    if (next > count()) next = 1;
    setCurrent(next);
    scrollToCurrent();
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    apply();
  };

  const openBar = () => {
    setOpen(true);
    requestAnimationFrame(() => { inputRef?.focus(); inputRef?.select(); });
  };

  let hovered = false;

  const selectAllShadow = () => {
    if (!shadow) return;
    // Collect the first/last text nodes inside the shadow so the selection
    // anchors land on real text — selectNodeContents on the shadow root
    // doesn't paint a visible selection in WebKit.
    const walker = document.createTreeWalker(shadow as any, NodeFilter.SHOW_TEXT, {
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
    const sel = (shadow as any).getSelection?.() || window.getSelection();
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

  const isTextField = (el: Element | null) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
  };

  const onWindowKey = (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const k = e.key.toLowerCase();
    const target = e.target as Element | null;
    if (k === "f") {
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.closest(".cm-editor")) return;
      e.preventDefault();
      e.stopPropagation();
      openBar();
    } else if (k === "a" && hovered) {
      // If the user is in our find input (or any text field), let the
      // browser's native Cmd+A select the field's text.
      if (isTextField(target) || isTextField(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      selectAllShadow();
    }
  };
  window.addEventListener("keydown", onWindowKey, true);
  onCleanup(() => window.removeEventListener("keydown", onWindowKey, true));

  return (
    <div
      class="w-full h-full flex flex-col"
      onMouseEnter={() => { hovered = true; }}
      onMouseLeave={() => { hovered = false; }}
    >
      <Show when={open()}>
        <div class="tcn-find shrink-0">
          <input
            ref={inputRef}
            class="tcn-find-input"
            placeholder="Find in preview"
            spellcheck={false}
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
      <div class="flex-1 min-h-0 overflow-auto bg-white">
        <div
          ref={(el) => {
            setHost(el);
            el.addEventListener("tcn-find", (() => openBar()) as EventListener);
          }}
          data-iframe-find-host
          class="min-h-full"
        />
      </div>
    </div>
  );
}
