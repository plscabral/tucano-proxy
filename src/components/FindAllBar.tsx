import { Show, createMemo } from "solid-js";
import { Search, X, CaseSensitive } from "lucide-solid";
import { findAllStore } from "../stores/findAll";
import { flowsStore } from "../stores/flows";
import { t } from "../lib/i18n";

export default function FindAllBar(props: { inputRef?: (el: HTMLInputElement) => void }) {
  const matchCount = createMemo(() => findAllStore.matches().size);
  const visible = createMemo(() => findAllStore.open());

  const jumpToFirstMatch = () => {
    const ids = findAllStore.matches();
    if (ids.size === 0) return;
    const first = flowsStore.flows().find((f) => ids.has(f.id));
    if (first) flowsStore.selectSingle(first.id);
  };

  return (
    <Show when={visible()}>
      <div class="flex items-center gap-2 px-3 py-2 border-b border-ink-100 dark:border-ink-400/30 bg-ink-50/60 dark:bg-ink-600/40">
        <Search size={13} class="opacity-60 shrink-0" />
        <input
          ref={(el) => props.inputRef?.(el)}
          data-findall-input
          type="text"
          spellcheck={false}
          autofocus
          value={findAllStore.query()}
          onInput={(e) => findAllStore.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); findAllStore.close(); }
            else if (e.key === "Enter") { e.preventDefault(); jumpToFirstMatch(); }
          }}
          placeholder={t("findAll.placeholder")}
          class="flex-1 bg-transparent outline-none text-xs mono"
        />
        <button
          onClick={() => findAllStore.setCaseSensitive(!findAllStore.caseSensitive())}
          title={t("findAll.caseSensitive")}
          class={`h-6 w-6 grid place-items-center rounded-md transition ${
            findAllStore.caseSensitive()
              ? "bg-slate-400/20 text-slate-200"
              : "opacity-50 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
          }`}
        >
          <CaseSensitive size={13} />
        </button>
        <span class="text-[11px] opacity-60 mono shrink-0 px-1">
          {findAllStore.query()
            ? t("findAll.count", { n: matchCount() })
            : t("findAll.hint")}
        </span>
        <button
          onClick={() => findAllStore.close()}
          title={t("findAll.close")}
          class="h-6 w-6 grid place-items-center rounded-md opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
        >
          <X size={13} />
        </button>
      </div>
    </Show>
  );
}
