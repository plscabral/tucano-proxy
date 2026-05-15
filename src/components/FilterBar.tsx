import { Plus, Filter as FilterIcon, ChevronDown, X, Zap, Trash2 } from "lucide-solid";
import { For, Show } from "solid-js";
import { rulesStore } from "../stores/rules";
import { FIELDS, opsFor, newRule, type Field, type Op } from "../lib/rules";
import { t } from "../lib/i18n";

export default function FilterBar() {
  const rules = rulesStore.rules;
  const add = () => rulesStore.add(newRule());

  return (
    <div class="tcn-glass border-b border-ink-100/40 dark:border-white/[0.05]">
      <div class="px-5 py-3 flex items-start gap-4">
        <div class="h-8 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] opacity-70 mono font-medium shrink-0 pt-0.5">
          <FilterIcon size={12} class="text-toucan-400" /> {t("filter.title")}
        </div>

        <div class="flex-1 flex flex-col gap-1.5 min-w-0">
          <Show when={rules().length === 0}>
            <button
              onClick={add}
              class="h-9 px-4 text-xs rounded-xl border border-dashed border-ink-200/60 dark:border-white/15 hover:border-toucan-400 hover:text-toucan-400 hover:bg-toucan-400/5 self-start flex items-center gap-1.5 transition">
              <Plus size={12} /> {t("filter.add")}
            </button>
          </Show>

          <For each={rules()}>{(r, i) => (<>
            <Show when={i() > 0}>
              <div class="flex items-center gap-2 my-0.5 ml-3">
                <div class="w-px h-3 bg-ink-200/40 dark:bg-white/15" />
                <button
                  onClick={() => rulesStore.setMatchMode(rulesStore.matchMode() === "all" ? "any" : "all")}
                  title={t("filter.matchModeHint")}
                  class="px-2 py-0.5 text-[10px] font-bold mono rounded tracking-[0.1em]
                         bg-toucan-400/15 text-toucan-400
                         hover:bg-toucan-400 hover:text-ink-500 transition"
                >{rulesStore.matchMode() === "all" ? t("filter.matchAll") : t("filter.matchAny")}</button>
                <div class="flex-1 h-px bg-gradient-to-r from-ink-200/40 dark:from-white/10 to-transparent" />
              </div>
            </Show>

            <div class={`group flex items-stretch rounded-xl overflow-hidden transition
              ${r.enabled
                ? "bg-white dark:bg-white/[0.04] ring-1 ring-inset ring-ink-200/60 dark:ring-white/10 hover:ring-toucan-400/50 focus-within:ring-toucan-400/70 shadow-sm"
                : "bg-white/40 dark:bg-white/[0.02] ring-1 ring-inset ring-ink-200/30 dark:ring-white/5 opacity-60"}`}>

              {/* Toggle on/off — sits inside the card on the left */}
              <button
                onClick={() => rulesStore.update(r.id, { enabled: !r.enabled })}
                title={r.enabled ? "Desativar regra" : "Ativar regra"}
                class={`shrink-0 w-9 grid place-items-center border-r border-ink-100/60 dark:border-white/10 transition
                  ${r.enabled
                    ? "text-toucan-400 hover:bg-toucan-400/10"
                    : "text-ink-300 dark:text-ink-200/40 hover:bg-white/5 hover:text-toucan-400"}`}
              >
                <Show when={r.enabled} fallback={<div class="h-3.5 w-3.5 rounded border border-current" />}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </Show>
              </button>

              <Segment width="w-32">
                <BareSelect
                  value={r.field}
                  onChange={(v) => {
                    const ops = opsFor(v as Field);
                    rulesStore.update(r.id, { field: v as Field, op: ops[0].id });
                  }}
                  options={FIELDS.map((f) => ({ id: f.id, label: t(`filter.field.${f.id}`) }))}
                />
              </Segment>

              <Segment width="w-44">
                <BareSelect
                  value={r.op}
                  onChange={(v) => rulesStore.update(r.id, { op: v as Op })}
                  options={opsFor(r.field).map((o) => ({ id: o.id, label: t(`filter.op.${o.id}`) }))}
                />
              </Segment>

              <div class="flex-1 min-w-0 border-r border-ink-100/60 dark:border-white/10">
                <input
                  data-filter-input
                  value={r.value}
                  onInput={(e) => rulesStore.update(r.id, { value: e.currentTarget.value })}
                  placeholder={r.field === "header" ? t("filter.headerPlaceholder") : t("filter.placeholder")}
                  title={r.field !== "header" && r.op !== "matches" ? t("filter.multiValueHint") : undefined}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  class="w-full h-9 px-3.5 text-sm mono bg-transparent border-0 outline-none placeholder:opacity-40"
                />
              </div>

              <button
                onClick={() => rulesStore.remove(r.id)}
                class="shrink-0 w-9 grid place-items-center text-ink-300 dark:text-ink-100/70 hover:bg-red-500/10 hover:text-red-500 transition"
                title={t("filter.remove")}
              ><X size={14} /></button>
            </div>
          </>)}</For>

          <Show when={rules().length > 0}>
            <button
              onClick={add}
              class="h-7 px-2.5 self-start text-[11px] rounded-lg text-ink-400 dark:text-ink-200/80
                     hover:bg-toucan-400/10 hover:text-toucan-500 dark:hover:text-toucan-400 flex items-center gap-1.5 transition mt-1 font-medium"
            ><Plus size={12} /> {t("filter.add")}</button>
          </Show>
        </div>

        <Show when={rules().length > 0}>
          <div class="flex items-center gap-1.5 shrink-0 pt-0.5">
            <button
              onClick={() => rulesStore.setCaptureMode(!rulesStore.captureMode())}
              title={t("filter.captureModeHint")}
              class={`h-8 px-3 text-[11px] rounded-xl flex items-center gap-1.5 transition font-medium
                ${rulesStore.captureMode()
                  ? "bg-toucan-400 text-ink-500 shadow-glow"
                  : "bg-white/40 dark:bg-white/[0.04] ring-1 ring-inset ring-ink-200/40 dark:ring-white/10 hover:ring-toucan-400/50 hover:text-toucan-400"}`}
            ><Zap size={12} /> {t("filter.captureMode")}</button>
            <button
              onClick={() => rulesStore.clear()}
              class="h-8 w-8 grid place-items-center rounded-xl text-ink-300 dark:text-ink-200/60 hover:bg-red-500/10 hover:text-red-500 transition"
              title={t("filter.clearAll")}
            ><Trash2 size={13} /></button>
          </div>
        </Show>
      </div>
    </div>
  );
}

function Segment(props: { width?: string; children: any }) {
  return (
    <div class={`${props.width ?? ""} shrink-0 border-r border-ink-100/60 dark:border-white/10 hover:bg-white/40 dark:hover:bg-white/[0.03] transition`}>
      {props.children}
    </div>
  );
}

function BareSelect(props: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <div class="relative h-full">
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        class="appearance-none w-full h-9 pl-3.5 pr-7 text-xs bg-transparent border-0 outline-none cursor-pointer mono font-medium"
      >
        <For each={props.options}>{(o) => <option value={o.id}>{o.label}</option>}</For>
      </select>
      <ChevronDown size={11} class="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50" />
    </div>
  );
}
