import { useEffect, useRef, useState } from "react";
import { X, StickyNote } from "lucide-react";
import { t } from "@/lib/i18n";

export default function NoteDialog({
  open,
  initialValue,
  onSave,
  onClose,
}: {
  open: boolean;
  initialValue: string;
  onSave: (value: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Resync only when the dialog transitions to open — flow-array updates that
  // re-render the parent must not wipe whatever the user has typed.
  useEffect(() => {
    if (open) {
      setValue(initialValue ?? "");
      queueMicrotask(() => textareaRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const commit = () => {
    const v = value.trim();
    onSave(v.length > 0 ? v : null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={onKey}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-2xl bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-100 dark:border-ink-400/30">
          <StickyNote size={14} className="text-toucan-400" />
          <span className="text-sm font-semibold">{t("note.title")}</span>
          <div className="flex-1" />
          <button onClick={onClose}
            className="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20">
            <X size={14} />
          </button>
        </div>
        <div className="p-4">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={onKey}
            rows={4}
            placeholder={t("note.placeholder")}
            className="w-full px-3 py-2 text-sm rounded-xl bg-ink-50 dark:bg-ink-600 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] opacity-70 mt-2.5">
            <span className="flex items-center gap-1.5">
              <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100 dark:bg-ink-400/30 border border-ink-200 dark:border-ink-400/50 text-[10px]">Enter</kbd>
              <span className="opacity-70">{t("note.kbd.save")}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100 dark:bg-ink-400/30 border border-ink-200 dark:border-ink-400/50 text-[10px]">Shift</kbd>
              <span className="opacity-50">+</span>
              <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100 dark:bg-ink-400/30 border border-ink-200 dark:border-ink-400/50 text-[10px]">Enter</kbd>
              <span className="opacity-70">{t("note.kbd.newline")}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100 dark:bg-ink-400/30 border border-ink-200 dark:border-ink-400/50 text-[10px]">Esc</kbd>
              <span className="opacity-70">{t("note.kbd.cancel")}</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-100 dark:border-ink-400/30">
          {initialValue && (
            <button
              onClick={() => onSave(null)}
              className="h-9 px-3 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10"
            >{t("note.remove")}</button>
          )}
          <div className="flex-1" />
          <button onClick={onClose}
            className="h-9 px-3 text-xs rounded-xl hover:bg-ink-50 dark:hover:bg-ink-400/20">
            {t("note.cancel")}
          </button>
          <button onClick={commit}
            className="h-9 px-4 text-xs rounded-xl bg-toucan-400 text-ink-500 font-medium hover:bg-toucan-300">
            {t("note.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
