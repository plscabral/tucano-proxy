import { Columns3, RotateCcw, GripVertical } from "lucide-react";
import { useState } from "react";
import { useColumns, type ColId } from "@/stores/columns";
import { t } from "@/lib/i18n";

export default function ColumnsMenu() {
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<ColId | null>(null);
  const [overId, setOverId] = useState<ColId | null>(null);
  const cols = useColumns((s) => s.list);
  const cs = useColumns.getState();

  const onDrop = (targetId: ColId) => {
    const id = dragId;
    setDragId(null);
    setOverId(null);
    if (!id || id === targetId) return;
    const to = cs.list.findIndex((c) => c.id === targetId);
    if (to !== -1) cs.move(id, to);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={t("tb.columnsTitle")}
        className="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
      >
        <Columns3 size={13} /> {t("tb.columns")}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 top-10 right-0 w-60 tcn-glass-strong rounded-2xl shadow-elev p-2 text-xs">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider opacity-50">{t("cols.visible")}</div>
            {cols.map((c) => (
              <label
                key={c.id}
                draggable
                onDragStart={(e) => {
                  setDragId(c.id);
                  e.dataTransfer?.setData("text/plain", c.id);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                  if (overId !== c.id) setOverId(c.id);
                }}
                onDragLeave={() => { if (overId === c.id) setOverId(null); }}
                onDrop={(e) => { e.preventDefault(); onDrop(c.id); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg cursor-pointer transition
                  ${dragId === c.id ? "opacity-40" : ""}
                  ${overId === c.id && dragId && dragId !== c.id ? "bg-toucan-400/15 ring-1 ring-toucan-400/50" : "hover:bg-ink-50 dark:hover:bg-ink-400/20"}`}
              >
                <GripVertical size={12} className="opacity-40 cursor-grab active:cursor-grabbing shrink-0" />
                <input type="checkbox" checked={c.visible} onChange={() => cs.toggle(c.id)} className="accent-toucan-400" />
                <span className="flex-1 truncate">{t(`col.${c.id}`)}</span>
                <span className="opacity-40 mono">{c.id}</span>
              </label>
            ))}
            <button
              onClick={() => cs.reset()}
              className="mt-1 w-full px-2 py-1.5 rounded-lg flex items-center gap-1.5 hover:bg-ink-50 dark:hover:bg-ink-400/20 opacity-70 hover:opacity-100"
            ><RotateCcw size={12} /> {t("cols.reset")}</button>
          </div>
        </>
      )}
    </div>
  );
}
