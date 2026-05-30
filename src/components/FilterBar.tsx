import { useEffect, useState } from "react";
import { Filter as FilterIcon, Plus, X, Zap, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRules } from "@/stores/rules";
import { newRule } from "@/lib/rules";
import { purgeNonMatchingNow } from "@/lib/captureFilter";
import { t } from "@/lib/i18n";
import FiltersDialog from "./FiltersDialog";

export default function FilterBar() {
  const rules = useRules((s) => s.list);
  const matchMode = useRules((s) => s.matchMode);
  const captureMode = useRules((s) => s.captureMode);
  const rs = useRules.getState();
  const [open, setOpen] = useState(false);

  // Open the advanced-filters dialog; seed a first rule if there are none.
  const openDialog = () => {
    if (useRules.getState().list.length === 0) rs.add(newRule());
    setOpen(true);
  };

  // Cmd+K (handled in App) asks us to open the builder.
  useEffect(() => {
    const onOpen = () => openDialog();
    window.addEventListener("tucano:open-filters", onOpen);
    return () => window.removeEventListener("tucano:open-filters", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only rules with a value actually filter — an empty rule the user just
  // added isn't a "filter" yet, so it shouldn't show as a chip or count.
  const meaningful = rules.filter((r) => r.value.trim() !== "");
  const active = meaningful.length;
  const toggleCapture = () => {
    const on = !captureMode;
    rs.setCaptureMode(on);
    if (on) purgeNonMatchingNow(); // retroactively drop already-captured non-matches
  };

  return (
    <div className="relative z-20 tcn-glass border-b border-ink-100/40 dark:border-white/[0.06]">
      <div className="px-5 min-h-[44px] py-2 flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] opacity-70 mono font-medium shrink-0">
          <FilterIcon size={12} className="text-toucan-400" /> {t("filter.title")}
        </div>

        {active === 0 ? (
          <button
            onClick={openDialog}
            className="h-8 px-3.5 text-xs rounded-xl border border-dashed border-ink-200/60 dark:border-white/15 hover:border-toucan-400 hover:text-toucan-500 dark:hover:text-toucan-300 hover:bg-toucan-400/5 flex items-center gap-1.5 transition"
          ><Plus size={13} /> {t("filter.add")}</button>
        ) : (
          <>
            {/* Active-filter chips — single scrollable row so they never grow the bar. */}
            <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scroll-thin py-0.5">
              {meaningful.map((r, i) => (
                <div key={r.id} className="flex items-center gap-1.5 shrink-0">
                  {i > 0 && <span className="text-[9px] mono font-bold tracking-wider text-toucan-500/70 dark:text-toucan-300/70">{matchMode === "all" ? t("filter.matchAll") : t("filter.matchAny")}</span>}
                  <button
                    onClick={openDialog}
                    title={t("filter.title")}
                    className={`group flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-lg text-[11px] mono ring-1 ring-inset transition
                      ${r.enabled ? "bg-card ring-border hover:ring-toucan-400/50" : "bg-muted/40 ring-border/60 opacity-55"}`}
                  >
                    <span className="text-toucan-500 dark:text-toucan-300 font-semibold">{t(`filter.field.${r.field}`)}</span>
                    <span className="opacity-45">{t(`filter.op.${r.op}`).toLowerCase()}</span>
                    <span className="truncate max-w-[140px] opacity-90">{r.value}</span>
                    <span
                      onClick={(e) => { e.stopPropagation(); rs.remove(r.id); }}
                      className="h-5 w-5 grid place-items-center rounded-md opacity-40 group-hover:opacity-70 hover:!opacity-100 hover:bg-destructive/15 hover:text-destructive transition"
                    ><X size={11} /></span>
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={openDialog}
              className="h-8 px-3 text-xs rounded-xl ring-1 ring-inset ring-border hover:ring-toucan-400/50 hover:text-toucan-500 dark:hover:text-toucan-300 flex items-center gap-1.5 transition shrink-0"
            ><SlidersHorizontal size={13} /> {t("filter.add")} <span className="text-[10px] mono px-1 rounded bg-toucan-400/15 text-toucan-500 dark:text-toucan-300">{active}</span></button>

            {/* Destructive capture toggle — amber (not violet) so it never gets
                confused with the primary "Capturar" button and signals risk. */}
            <button
              onClick={toggleCapture}
              title={t("filter.captureModeHint")}
              className={`h-8 px-3 text-[11px] rounded-xl flex items-center gap-1.5 transition font-medium shrink-0
                ${captureMode
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-300 ring-1 ring-inset ring-amber-500/35 shadow-[0_0_16px_-6px_rgb(245_158_11_/_0.5)]"
                  : "ring-1 ring-inset ring-border text-muted-foreground hover:ring-amber-400/50 hover:text-amber-600 dark:hover:text-amber-300"}`}
            ><Zap size={12} /> {t("filter.captureMode")}</button>

            <button
              onClick={() => rs.clear()}
              title={t("filter.clearAll")}
              className="h-8 w-8 grid place-items-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition shrink-0"
            ><Trash2 size={14} /></button>
          </>
        )}
      </div>

      <FiltersDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
