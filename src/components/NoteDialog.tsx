import { createEffect, createSignal, Show } from "solid-js";
import { X, StickyNote } from "lucide-solid";
import { t } from "../lib/i18n";

export default function NoteDialog(props: {
  open: boolean;
  initialValue: string;
  onSave: (value: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = createSignal("");
  let textareaRef!: HTMLTextAreaElement;

  // Resync the editable text whenever the dialog opens for a new flow.
  createEffect(() => {
    if (props.open) {
      setValue(props.initialValue ?? "");
      // Focus + select on next tick so the modal is in the DOM.
      queueMicrotask(() => textareaRef?.focus());
    }
  });

  const commit = () => {
    const v = value().trim();
    props.onSave(v.length > 0 ? v : null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
        onClick={props.onClose}
        onKeyDown={onKey}
      >
        <div
          class="w-[460px] max-w-[92vw] rounded-2xl bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-4 py-3 border-b border-ink-100 dark:border-ink-400/30">
            <StickyNote size={14} class="text-toucan-400" />
            <span class="text-sm font-semibold">{t("note.title")}</span>
            <div class="flex-1" />
            <button onClick={props.onClose}
              class="h-7 w-7 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20">
              <X size={14} />
            </button>
          </div>
          <div class="p-4">
            <textarea
              ref={textareaRef}
              value={value()}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={onKey}
              rows={4}
              placeholder={t("note.placeholder")}
              class="w-full px-3 py-2 text-sm rounded-xl bg-ink-50 dark:bg-ink-600 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
            />
            <div class="text-[11px] opacity-50 mt-2 mono">{t("note.hint")}</div>
          </div>
          <div class="flex items-center gap-2 px-4 py-3 border-t border-ink-100 dark:border-ink-400/30">
            <Show when={props.initialValue}>
              <button
                onClick={() => props.onSave(null)}
                class="h-9 px-3 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10"
              >{t("note.remove")}</button>
            </Show>
            <div class="flex-1" />
            <button onClick={props.onClose}
              class="h-9 px-3 text-xs rounded-xl hover:bg-ink-50 dark:hover:bg-ink-400/20">
              {t("note.cancel")}
            </button>
            <button onClick={commit}
              class="h-9 px-4 text-xs rounded-xl bg-toucan-400 text-ink-500 font-medium hover:bg-toucan-300">
              {t("note.save")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
