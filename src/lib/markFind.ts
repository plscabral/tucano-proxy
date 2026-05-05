// Wrap text matches with <mark class="tcn-hl"> in a live DOM, and restore
// the original text when cleared. Per-text-node wrapping keeps things
// robust: matches that cross element boundaries are simply skipped (Chrome's
// native find skips them too in many cases), but everything else just works.

const HL_CLASS = "tcn-hl";
const CUR_CLASS = "tcn-hl-cur";

export type MarkFindResult = { marks: HTMLElement[] };

export function findAndMark(root: Node, query: string, ownerDoc: Document): MarkFindResult {
  unmark(root);
  if (!query) return { marks: [] };
  const lc = query.toLowerCase();

  // Collect candidate text nodes first to avoid mutating during walk.
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("script,style,noscript,template,head,title")) return NodeFilter.FILTER_REJECT;
      if (p.nodeName === "MARK" && p.classList.contains(HL_CLASS)) return NodeFilter.FILTER_REJECT;
      if ((p as HTMLElement).offsetParent === null && p.tagName !== "BODY") return NodeFilter.FILTER_REJECT;
      const cs = (ownerDoc.defaultView ?? window).getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  const marks: HTMLElement[] = [];
  for (const original of targets) {
    let node = original as Text;
    let value = node.nodeValue ?? "";
    let lower = value.toLowerCase();
    let from = 0;
    while (true) {
      const idx = lower.indexOf(lc, from);
      if (idx < 0) break;
      // Split: [pre][match][rest] — wrap [match] in a <mark>.
      const after = node.splitText(idx);
      const tail = after.splitText(lc.length);
      const mark = ownerDoc.createElement("mark");
      mark.className = HL_CLASS;
      mark.appendChild(after.cloneNode(true));
      after.parentNode!.replaceChild(mark, after);
      marks.push(mark);
      // Continue scanning after the match in the tail node.
      node = tail;
      value = node.nodeValue ?? "";
      lower = value.toLowerCase();
      from = 0;
    }
  }
  return { marks };
}

export function setCurrent(marks: HTMLElement[], index: number) {
  for (let i = 0; i < marks.length; i++) {
    if (i === index) marks[i].classList.add(CUR_CLASS);
    else marks[i].classList.remove(CUR_CLASS);
  }
}

export function unmark(root: Node) {
  const ownerDoc = (root as Document).createElement
    ? (root as Document)
    : (root as HTMLElement).ownerDocument ?? document;
  const marks = (root as ParentNode).querySelectorAll?.(`mark.${HL_CLASS}`) ?? [];
  marks.forEach((m) => {
    const text = m.textContent ?? "";
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(ownerDoc.createTextNode(text), m);
    parent.normalize?.();
  });
}

// Same palette browsers use for native find: solid yellow for all matches,
// orange highlight for the current one.
export const FIND_CSS =
  `mark.${HL_CLASS} { background: #FFFF00; color: #000; padding: 0; }` +
  `mark.${CUR_CLASS} { background: #FF9632; color: #000; }`;
