import { Plus, Filter as FilterIcon, ChevronDown, X, Zap, Trash2 } from "lucide-react";
import { useRules } from "@/stores/rules";
import { FIELDS, opsFor, newRule, type Field, type Op } from "@/lib/rules";
import { t } from "@/lib/i18n";

export default function FilterBar() {
  const rules = useRules((s) => s.list);
  const matchMode = useRules((s) => s.matchMode);
  const captureMode = useRules((s) => s.captureMode);
  const rs = useRules.getState();
  const add = () => rs.add(newRule());

  return (
    <div className="relative z-20 tcn-glass border-b border-ink-100/40 dark:border-white/[0.05]">
      <div className="px-5 py-3 flex items-start gap-4">
        <div className="h-8 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] opacity-70 mono font-medium shrink-0 pt-0.5">
          <FilterIcon size={12} className="text-toucan-400" /> {t("filter.title")}
        </div>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          {rules.length === 0 && (
            <button
              onClick={add}
              className="h-9 px-4 text-xs rounded-xl border border-dashed border-ink-200/60 dark:border-white/15 hover:border-toucan-400 hover:text-toucan-400 hover:bg-toucan-400/5 self-start flex items-center gap-1.5 transition">
              <Plus size={12} /> {t("filter.add")}
            </button>
          )}

          {rules.map((r, i) => (
            <div key={r.id}>
              {i > 0 && (
                <div className="flex items-center gap-2 my-0.5 ml-3">
                  <div className="w-px h-3 bg-ink-200/40 dark:bg-white/15" />
                  <button
                    onClick={() => rs.setMatchMode(matchMode === "all" ? "any" : "all")}
                    title={t("filter.matchModeHint")}
                    className="px-2 py-0.5 text-[10px] font-bold mono rounded tracking-[0.1em] bg-toucan-400/15 text-toucan-400 hover:bg-toucan-400 hover:text-white transition"
                  >{matchMode === "all" ? t("filter.matchAll") : t("filter.matchAny")}</button>
                  <div className="flex-1 h-px bg-gradient-to-r from-ink-200/40 dark:from-white/10 to-transparent" />
                </div>
              )}

              <div className={`group flex items-stretch rounded-xl overflow-hidden transition
                ${r.enabled
                  ? "bg-white dark:bg-white/[0.04] ring-1 ring-inset ring-ink-200/60 dark:ring-white/10 hover:ring-toucan-400/50 focus-within:ring-toucan-400/70 shadow-sm"
                  : "bg-white/40 dark:bg-white/[0.02] ring-1 ring-inset ring-ink-200/30 dark:ring-white/5 opacity-60"}`}>
                <button
                  onClick={() => rs.update(r.id, { enabled: !r.enabled })}
                  title={r.enabled ? "Desativar regra" : "Ativar regra"}
                  className={`shrink-0 w-9 grid place-items-center border-r border-ink-100/60 dark:border-white/10 transition
                    ${r.enabled ? "text-toucan-400 hover:bg-toucan-400/10" : "text-ink-300 dark:text-ink-200/40 hover:bg-white/5 hover:text-toucan-400"}`}
                >
                  {r.enabled ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : <div className="h-3.5 w-3.5 rounded border border-current" />}
                </button>

                <Segment width="w-32">
                  <BareSelect
                    value={r.field}
                    onChange={(v) => { const ops = opsFor(v as Field); rs.update(r.id, { field: v as Field, op: ops[0].id }); }}
                    options={FIELDS.map((f) => ({ id: f.id, label: t(`filter.field.${f.id}`) }))}
                  />
                </Segment>

                <Segment width="w-44">
                  <BareSelect
                    value={r.op}
                    onChange={(v) => rs.update(r.id, { op: v as Op })}
                    options={opsFor(r.field).map((o) => ({ id: o.id, label: t(`filter.op.${o.id}`) }))}
                  />
                </Segment>

                <div className="flex-1 min-w-0 border-r border-ink-100/60 dark:border-white/10">
                  <input
                    data-filter-input
                    value={r.value}
                    onChange={(e) => rs.update(r.id, { value: e.currentTarget.value })}
                    placeholder={r.field === "header" ? t("filter.headerPlaceholder") : t("filter.placeholder")}
                    title={r.field !== "header" && r.op !== "matches" ? t("filter.multiValueHint") : undefined}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full h-9 px-3.5 text-sm mono bg-transparent border-0 outline-none placeholder:opacity-40"
                  />
                </div>

                <button
                  onClick={() => rs.remove(r.id)}
                  className="shrink-0 w-9 grid place-items-center text-ink-300 dark:text-ink-100/70 hover:bg-red-500/10 hover:text-red-500 transition"
                  title={t("filter.remove")}
                ><X size={14} /></button>
              </div>
            </div>
          ))}

          {rules.length > 0 && (
            <button
              onClick={add}
              className="h-7 px-2.5 self-start text-[11px] rounded-lg text-ink-400 dark:text-ink-200/80 hover:bg-toucan-400/10 hover:text-toucan-500 dark:hover:text-toucan-400 flex items-center gap-1.5 transition mt-1 font-medium"
            ><Plus size={12} /> {t("filter.add")}</button>
          )}
        </div>

        {rules.length > 0 && (
          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            <button
              onClick={() => rs.setCaptureMode(!captureMode)}
              title={t("filter.captureModeHint")}
              className={`h-9 px-3.5 text-[11px] rounded-xl flex items-center gap-1.5 transition font-medium
                ${captureMode
                  ? "bg-toucan-400 text-white shadow-glow"
                  : "bg-white/40 dark:bg-white/[0.04] ring-1 ring-inset ring-ink-200/40 dark:ring-white/10 hover:ring-toucan-400/50 hover:text-toucan-400"}`}
            ><Zap size={12} /> {t("filter.captureMode")}</button>
            <button
              onClick={() => rs.clear()}
              className="h-9 w-9 grid place-items-center rounded-xl text-ink-400 dark:text-ink-100 hover:bg-red-500/15 hover:text-red-500 dark:hover:text-red-400 transition"
              title={t("filter.clearAll")}
            ><Trash2 size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function Segment({ width, children }: { width?: string; children: React.ReactNode }) {
  return (
    <div className={`${width ?? ""} shrink-0 border-r border-ink-100/60 dark:border-white/10 hover:bg-white/40 dark:hover:bg-white/[0.03] transition`}>
      {children}
    </div>
  );
}

function BareSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[] }) {
  return (
    <div className="relative h-full">
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="appearance-none w-full h-9 pl-3.5 pr-7 text-xs bg-transparent border-0 outline-none cursor-pointer mono font-medium"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50" />
    </div>
  );
}
