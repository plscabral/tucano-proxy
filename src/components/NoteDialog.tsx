import { useEffect, useRef, useState } from "react";
import { StickyNote } from "lucide-react";
import { t } from "@/lib/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

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

  // Resync only when the dialog transitions to open — parent re-renders must
  // not wipe whatever the user has typed.
  useEffect(() => {
    if (open) setValue(initialValue ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = () => {
    const v = value.trim();
    onSave(v.length > 0 ? v : null);
  };

  const Kbd = ({ children }: { children: React.ReactNode }) => (
    <kbd className="mono px-1.5 py-0.5 rounded-md bg-ink-100/70 dark:bg-white/[0.06] ring-1 ring-inset ring-border text-[10px]">{children}</kbd>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-[480px] gap-0 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => { e.preventDefault(); textareaRef.current?.focus(); }}
      >
        {/* Header with ambient brand glow */}
        <div className="relative px-5 pt-4 pb-3.5 border-b border-border overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-16 tcn-glow-radial pointer-events-none" />
          <DialogHeader className="relative">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl tcn-accent-soft ring-1 ring-inset ring-toucan-400/25 text-toucan-500 dark:text-toucan-300 grid place-items-center">
                <StickyNote size={15} />
              </div>
              <DialogTitle className="text-base font-bold tracking-tight">{t("note.title")}</DialogTitle>
            </div>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="p-5">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } }}
            rows={4}
            placeholder={t("note.placeholder")}
            className="w-full px-3 py-2.5 text-sm rounded-xl bg-muted ring-1 ring-inset ring-border focus:ring-2 focus:ring-toucan-400/50 outline-none resize-y transition"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] opacity-65 mt-3">
            <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd> {t("note.kbd.save")}</span>
            <span className="flex items-center gap-1.5"><Kbd>Shift</Kbd><span className="opacity-50">+</span><Kbd>Enter</Kbd> {t("note.kbd.newline")}</span>
            <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> {t("note.kbd.cancel")}</span>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3.5 border-t border-border bg-muted/30 sm:justify-between gap-2">
          {initialValue ? (
            <button
              onClick={() => onSave(null)}
              className="h-9 px-3 text-xs rounded-xl ring-1 ring-inset ring-destructive/40 text-destructive hover:bg-destructive/10 transition"
            >{t("note.remove")}</button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-9 px-3.5 text-xs rounded-xl hover:bg-muted transition">{t("note.cancel")}</button>
            <button onClick={commit} className="h-9 px-5 text-xs rounded-xl tcn-accent tcn-accent-glow font-semibold transition hover:brightness-110">{t("note.save")}</button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
