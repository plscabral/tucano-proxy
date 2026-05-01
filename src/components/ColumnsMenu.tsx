import { Columns3, RotateCcw, GripVertical } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { columnsStore, type ColId } from "../stores/columns";
import { t } from "../lib/i18n";

export default function ColumnsMenu() {
  const [open, setOpen] = createSignal(false);
  const [dragId, setDragId] = createSignal<ColId | null>(null);
  const [overId, setOverId] = createSignal<ColId | null>(null);

  const onDrop = (targetId: ColId) => {
    const id = dragId();
    setDragId(null);
    setOverId(null);
    if (!id || id === targetId) return;
    const cols = columnsStore.cols();
    const to = cols.findIndex((c) => c.id === targetId);
    if (to !== -1) columnsStore.move(id, to);
  };

  return (
    <div class="relative">
      <button
        onClick={() => setOpen(!open())}
        title={t("tb.columnsTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
      >
        <Columns3 size={13} /> {t("tb.columns")}
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-30" onClick={() => setOpen(false)} />
        <div class="absolute z-40 top-10 right-0 w-60 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl p-2 text-xs">
          <div class="px-2 py-1 text-[10px] uppercase tracking-wider opacity-50">{t("cols.visible")}</div>
          <For each={columnsStore.cols()}>{(c) => (
            <label
              draggable={true}
              onDragStart={(e) => {
                setDragId(c.id);
                e.dataTransfer?.setData("text/plain", c.id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                if (overId() !== c.id) setOverId(c.id);
              }}
              onDragLeave={() => { if (overId() === c.id) setOverId(null); }}
              onDrop={(e) => { e.preventDefault(); onDrop(c.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              class={`flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg cursor-pointer transition
                ${dragId() === c.id ? "opacity-40" : ""}
                ${overId() === c.id && dragId() && dragId() !== c.id
                  ? "bg-toucan-400/15 ring-1 ring-toucan-400/50"
                  : "hover:bg-ink-50 dark:hover:bg-ink-400/20"}`}
            >
              <GripVertical size={12} class="opacity-40 cursor-grab active:cursor-grabbing shrink-0" />
              <input
                type="checkbox"
                checked={c.visible}
                onChange={() => columnsStore.toggle(c.id)}
                class="accent-toucan-400"
              />
              <span class="flex-1 truncate">{t(`col.${c.id}`)}</span>
              <span class="opacity-40 mono">{c.id}</span>
            </label>
          )}</For>
          <button
            onClick={() => columnsStore.reset()}
            class="mt-1 w-full px-2 py-1.5 rounded-lg flex items-center gap-1.5 hover:bg-ink-50 dark:hover:bg-ink-400/20 opacity-70 hover:opacity-100"
          ><RotateCcw size={12} /> {t("cols.reset")}</button>
        </div>
      </Show>
    </div>
  );
}
