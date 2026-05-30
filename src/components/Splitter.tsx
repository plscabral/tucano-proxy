import * as React from "react";

// Mouse-based drag splitter. Bypasses HTML5 DnD (flaky in WebView) and keeps
// the exact percentage-based layout logic the layout store already tunes.
export default function Splitter({
  orientation,
  onDrag,
  containerRef,
}: {
  orientation: "vertical" | "horizontal"; // vertical = drag horizontally (col split)
  onDrag: (clientX: number, clientY: number, rect: DOMRect) => void;
  containerRef: () => HTMLElement | null;
}) {
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const c = containerRef();
    if (!c) return;
    const move = (ev: MouseEvent) => {
      onDrag(ev.clientX, ev.clientY, c.getBoundingClientRect());
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const isVertical = orientation === "vertical";
  return (
    <div
      onMouseDown={start}
      className={`group relative shrink-0 z-10
        ${isVertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}
        bg-ink-100 dark:bg-white/[0.06] hover:bg-ink-300 dark:hover:bg-white/20 transition-colors`}
    >
      {/* Larger invisible hit-area so the 1px line is still grabbable. */}
      <div className={`absolute ${isVertical ? "inset-y-0 -inset-x-1.5" : "inset-x-0 -inset-y-1.5"}`} />
    </div>
  );
}
