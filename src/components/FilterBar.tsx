import { Plus, Minus, Filter as FilterIcon, ChevronDown, X } from "lucide-solid";
import { For, Show } from "solid-js";
import { rulesStore } from "../stores/rules";
import { FIELDS, opsFor, newRule, type Field, type Op } from "../lib/rules";
import { t } from "../lib/i18n";

export default function FilterBar() {
  const rules = rulesStore.rules;
  const add = () => rulesStore.add(newRule());

  return (
    <div class="bg-white dark:bg-ink-500 border-b border-ink-100 dark:border-ink-400/30">
      <div class="px-5 py-3 flex items-start gap-3">
        <div class="h-9 px-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider opacity-60 mono">
          <FilterIcon size={12} /> {t("filter.title")}
        </div>

        <div class="flex-1 flex flex-col gap-2">
          <Show when={rules().length === 0}>
            <button
              onClick={add}
              class="h-9 px-4 text-xs rounded-xl border border-dashed border-ink-200 dark:border-ink-400/40 hover:border-toucan-400 hover:text-toucan-400 self-start flex items-center gap-1.5">
              <Plus size={12} /> {t("filter.add")}
            </button>
          </Show>

          <For each={rules()}>{(r) => (
            <div class="flex items-center gap-2">
              <button
                onClick={() => rulesStore.update(r.id, { enabled: !r.enabled })}
                class={`h-8 w-8 grid place-items-center rounded-xl border transition shrink-0
                  ${r.enabled
                    ? "bg-toucan-400 border-toucan-400 text-ink-500"
                    : "border-ink-200 dark:border-ink-400/40 opacity-50"}`}
              >
                {r.enabled && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>

              <Select
                value={r.field}
                onChange={(v) => {
                  const ops = opsFor(v as Field);
                  rulesStore.update(r.id, { field: v as Field, op: ops[0].id });
                }}
                options={FIELDS.map((f) => ({ id: f.id, label: t(`filter.field.${f.id}`) }))}
                width="w-36"
              />

              <Select
                value={r.op}
                onChange={(v) => rulesStore.update(r.id, { op: v as Op })}
                options={opsFor(r.field).map((o) => ({ id: o.id, label: t(`filter.op.${o.id}`) }))}
                width="w-44"
              />

              <input
                data-filter-input
                value={r.value}
                onInput={(e) => rulesStore.update(r.id, { value: e.currentTarget.value })}
                placeholder={r.field === "header" ? t("filter.headerPlaceholder") : t("filter.placeholder")}
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                class="flex-1 h-8 px-3.5 text-sm mono rounded-xl bg-ink-50 dark:bg-ink-600 border border-transparent focus:border-toucan-400 outline-none placeholder:opacity-40"
              />

              <button
                onClick={() => rulesStore.remove(r.id)}
                class="h-8 w-8 grid place-items-center rounded-xl text-ink-300 hover:bg-red-500/10 hover:text-red-500 transition shrink-0"
                title={t("filter.remove")}
              ><Minus size={14} /></button>

              <button
                onClick={add}
                class="h-8 w-8 grid place-items-center rounded-xl text-ink-300 hover:bg-toucan-400/10 hover:text-toucan-400 transition shrink-0"
                title={t("filter.add")}
              ><Plus size={14} /></button>
            </div>
          )}</For>
        </div>

        <Show when={rules().length > 0}>
          <button
            onClick={() => rulesStore.clear()}
            class="h-8 px-3 text-[11px] rounded-xl hover:bg-red-500/10 hover:text-red-500 flex items-center gap-1.5 shrink-0"
            title={t("filter.clearAll")}
          ><X size={12} /> {t("filter.clear")}</button>
        </Show>
      </div>
    </div>
  );
}

function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  width?: string;
}) {
  return (
    <div class={`relative ${props.width ?? ""} shrink-0`}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        class="appearance-none w-full h-8 pl-3.5 pr-8 text-xs rounded-xl
               bg-ink-50 dark:bg-ink-600 border border-transparent
               hover:border-ink-200 dark:hover:border-ink-400/40
               focus:border-toucan-400 outline-none cursor-pointer mono"
      >
        <For each={props.options}>{(o) => <option value={o.id}>{o.label}</option>}</For>
      </select>
      <ChevronDown size={12} class="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
    </div>
  );
}
