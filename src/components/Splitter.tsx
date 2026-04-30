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
        ${isVertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
        bg-ink-100 dark:bg-ink-400/30 hover:bg-toucan-400 transition-colors`}
    >
      <div class={`absolute ${isVertical ? "inset-y-0 -inset-x-1" : "inset-x-0 -inset-y-1"}`} />
    </div>
  );
}
