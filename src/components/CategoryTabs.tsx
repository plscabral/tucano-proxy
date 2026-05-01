import { For, Show } from "solid-js";
import { flowsStore } from "../stores/flows";
import { CATEGORIES, type Category } from "../lib/category";
import { t } from "../lib/i18n";

const CAT_DOT: Record<Category, string> = {
  all:       "bg-toucan-400",
  http:      "bg-sky-400",
  https:     "bg-emerald-400",
  websocket: "bg-fuchsia-400",
  json:      "bg-amber-400",
  form:      "bg-teal-400",
  xml:       "bg-orange-400",
  js:        "bg-yellow-400",
  css:       "bg-pink-400",
  graphql:   "bg-fuchsia-500",
  document:  "bg-blue-400",
  media:     "bg-violet-400",
  other:     "bg-ink-200",
};

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
              class={`shrink-0 h-8 px-3 text-xs rounded-full transition mono flex items-center gap-1.5
                ${active() === c.id
                  ? "bg-toucan-400 text-ink-500 font-semibold"
                  : "opacity-75 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20"}`}
            >
              <Show when={c.id !== "all"}>
                <span class={`h-1.5 w-1.5 rounded-full ${CAT_DOT[c.id]} ${active() === c.id ? "opacity-90" : ""}`} />
              </Show>
              {t(`cat.${c.id}`)}
            </button>
          </>
        );
      }}</For>
    </div>
  );
}
