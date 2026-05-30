import { Plus, X, Zap, Trash2, Check, SlidersHorizontal } from "lucide-react";
import { useRules } from "@/stores/rules";
import { FIELDS, opsFor, newRule, type Field, type Op } from "@/lib/rules";
import { t } from "@/lib/i18n";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export default function FiltersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const rules = useRules((s) => s.list);
  const matchMode = useRules((s) => s.matchMode);
  const captureMode = useRules((s) => s.captureMode);
  const rs = useRules.getState();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        {/* Header with ambient brand glow */}
        <div className="relative px-6 pt-5 pb-4 border-b border-border overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-24 tcn-glow-radial pointer-events-none" />
          <DialogHeader className="relative">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl tcn-accent-soft ring-1 ring-inset ring-toucan-400/25 text-toucan-500 dark:text-toucan-300 grid place-items-center">
                <SlidersHorizontal size={15} />
              </div>
              <div>
                <DialogTitle className="text-base font-bold tracking-tight">{t("filter.title")}</DialogTitle>
                <DialogDescription className="text-xs">{t("filter.matchModeHint")}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Rule list */}
        <div className="px-6 py-4 flex flex-col gap-2 max-h-[46vh] overflow-auto scroll-thin">
          {rules.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t("filter.add")} — <span className="font-accent">no filters yet</span>
            </div>
          )}

          {rules.map((r, i) => (
            <div key={r.id}>
              {i > 0 && (
                <div className="flex items-center gap-2 my-1 ml-2">
                  <div className="w-px h-3 bg-border" />
                  <button
                    onClick={() => rs.setMatchMode(matchMode === "all" ? "any" : "all")}
                    title={t("filter.matchModeHint")}
                    className="px-2 py-0.5 text-[10px] font-bold mono rounded tracking-[0.1em] bg-toucan-400/15 text-toucan-500 dark:text-toucan-300 hover:tcn-accent hover:text-white transition"
                  >{matchMode === "all" ? t("filter.matchAll") : t("filter.matchAny")}</button>
                  <div className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
                </div>
              )}

              <div className={`group flex items-center gap-2 rounded-xl p-1.5 ring-1 ring-inset transition
                ${r.enabled ? "bg-card ring-border" : "bg-muted/40 ring-border/60 opacity-60"}`}>
                <button
                  onClick={() => rs.update(r.id, { enabled: !r.enabled })}
                  title={r.enabled ? "Disable" : "Enable"}
                  className={`shrink-0 h-8 w-8 grid place-items-center rounded-lg transition
                    ${r.enabled ? "tcn-accent-soft text-toucan-500 dark:text-toucan-300 ring-1 ring-inset ring-toucan-400/25" : "text-muted-foreground hover:bg-muted"}`}
                >
                  {r.enabled ? <Check size={14} strokeWidth={3} /> : <span className="h-3.5 w-3.5 rounded border border-current" />}
                </button>

                <Select value={r.field} onValueChange={(v) => rs.update(r.id, { field: v as Field, op: opsFor(v as Field)[0].id })}>
                  <SelectTrigger className="w-32 h-9 text-xs mono shrink-0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELDS.map((f) => <SelectItem key={f.id} value={f.id} className="text-xs">{t(`filter.field.${f.id}`)}</SelectItem>)}
                  </SelectContent>
                </Select>

                <Select value={r.op} onValueChange={(v) => rs.update(r.id, { op: v as Op })}>
                  <SelectTrigger className="w-40 h-9 text-xs mono shrink-0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {opsFor(r.field).map((o) => <SelectItem key={o.id} value={o.id} className="text-xs">{t(`filter.op.${o.id}`)}</SelectItem>)}
                  </SelectContent>
                </Select>

                <Input
                  data-filter-input
                  value={r.value}
                  onChange={(e) => rs.update(r.id, { value: e.currentTarget.value })}
                  placeholder={r.field === "header" ? t("filter.headerPlaceholder") : t("filter.placeholder")}
                  className="flex-1 h-9 text-sm mono"
                  autoComplete="off" spellCheck={false}
                />

                <button
                  onClick={() => rs.remove(r.id)}
                  title={t("filter.remove")}
                  className="shrink-0 h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
                ><X size={15} /></button>
              </div>
            </div>
          ))}

          <button
            onClick={() => rs.add(newRule())}
            className="mt-1 h-10 self-start px-4 text-xs rounded-xl border border-dashed border-border hover:border-toucan-400/60 hover:text-toucan-500 dark:hover:text-toucan-300 hover:bg-toucan-400/5 flex items-center gap-1.5 transition"
          ><Plus size={13} /> {t("filter.add")}</button>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-3.5 border-t border-border bg-muted/30 sm:justify-between gap-2">
          <button
            onClick={() => rs.setCaptureMode(!captureMode)}
            title={t("filter.captureModeHint")}
            className={`h-9 px-3.5 text-[11px] rounded-xl flex items-center gap-1.5 transition font-medium
              ${captureMode
                ? "tcn-accent tcn-accent-glow"
                : "ring-1 ring-inset ring-border hover:ring-toucan-400/50 hover:text-toucan-500 dark:hover:text-toucan-300"}`}
          ><Zap size={13} /> {t("filter.captureMode")}</button>

          <div className="flex items-center gap-2">
            {rules.length > 0 && (
              <button
                onClick={() => rs.clear()}
                className="h-9 px-3 text-xs rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex items-center gap-1.5 transition"
              ><Trash2 size={13} /> {t("filter.clearAll")}</button>
            )}
            <button
              onClick={() => onOpenChange(false)}
              className="h-9 px-5 text-xs rounded-xl tcn-accent tcn-accent-glow font-semibold transition hover:brightness-110 flex items-center gap-1.5"
            ><Check size={14} strokeWidth={2.5} /> {t("find.close")}</button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
