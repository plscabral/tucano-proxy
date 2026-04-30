import { For } from "solid-js";
import { flowsStore } from "../stores/flows";
import { CATEGORIES } from "../lib/category";
import { t } from "../lib/i18n";

export default function CategoryTabs() {
  const active = flowsStore.category;
  return (
    <div class="h-12 flex items-center gap-1.5 px-4 bg-white dark:bg-ink-500 border-b border-ink-100 dark:border-ink-400/30 overflow-x-auto scroll-thin">
      <For each={CATEGORIES}>{(c, i) => {
        const prev = CATEGORIES[i() - 1];
        const sep = prev && prev.group !== c.group;
        return (
          <>
            {sep && <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-2 shrink-0" />}
            <button
              onClick={() => flowsStore.setCategory(c.id)}
              class={`shrink-0 h-8 px-3.5 text-xs rounded-full transition mono
                ${active() === c.id
                  ? "bg-toucan-400 text-ink-500 font-semibold"
                  : "opacity-70 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20"}`}
            >{t(`cat.${c.id}`)}</button>
          </>
        );
      }}</For>
    </div>
  );
}
