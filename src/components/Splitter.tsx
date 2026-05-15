export default function Splitter(props: {
  orientation: "vertical" | "horizontal"; // vertical = drag horizontally (col split)
  onDrag: (clientX: number, clientY: number, rect: DOMRect) => void;
  containerRef: () => HTMLElement | undefined;
}) {
  const start = (e: MouseEvent) => {
    e.preventDefault();
    const c = props.containerRef();
    if (!c) return;
    const move = (ev: MouseEvent) => {
      const rect = c.getBoundingClientRect();
      props.onDrag(ev.clientX, ev.clientY, rect);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = props.orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const isVertical = props.orientation === "vertical";
  return (
    <div
      onMouseDown={start}
      class={`group relative shrink-0 z-10
        ${isVertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}
        bg-ink-100 dark:bg-white/[0.06] hover:bg-ink-300 dark:hover:bg-white/20 transition-colors`}
    >
      {/* Larger invisible hit-area so the 1px line is still grabbable. */}
      <div class={`absolute ${isVertical ? "inset-y-0 -inset-x-1.5" : "inset-x-0 -inset-y-1.5"}`} />
    </div>
  );
}
