import { Search, X, CaseSensitive } from "lucide-react";
import { useFindAll } from "@/stores/findAll";
import { useFlows } from "@/stores/flows";
import { t } from "@/lib/i18n";

export default function FindAllBar() {
  const open = useFindAll((s) => s.open);
  const query = useFindAll((s) => s.query);
  const caseSensitive = useFindAll((s) => s.caseSensitive);
  const matchCount = useFindAll((s) => s.matches.size);
  const fa = useFindAll.getState();

  if (!open) return null;

  const jumpToFirstMatch = () => {
    const ids = useFindAll.getState().matches;
    if (ids.size === 0) return;
    const first = useFlows.getState().flows.find((f) => ids.has(f.id));
    if (first) useFlows.getState().selectSingle(first.id);
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-100 dark:border-ink-400/30 bg-ink-50/60 dark:bg-white/[0.04]">
      <Search size={13} className="opacity-60 shrink-0" />
      <input
        data-findall-input
        type="text"
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(e) => fa.setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); fa.close(); }
          else if (e.key === "Enter") { e.preventDefault(); jumpToFirstMatch(); }
        }}
        placeholder={t("findAll.placeholder")}
        className="flex-1 bg-transparent outline-none text-xs mono"
      />
      <button
        onClick={() => fa.setCaseSensitive(!caseSensitive)}
        title={t("findAll.caseSensitive")}
        className={`h-6 w-6 grid place-items-center rounded-md transition ${
          caseSensitive ? "bg-slate-400/20 text-slate-200" : "opacity-50 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
        }`}
      >
        <CaseSensitive size={13} />
      </button>
      <span className="text-[11px] opacity-60 mono shrink-0 px-1">
        {query ? t("findAll.count", { n: matchCount }) : t("findAll.hint")}
      </span>
      <button
        onClick={() => fa.close()}
        title={t("findAll.close")}
        className="h-6 w-6 grid place-items-center rounded-md opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
      >
        <X size={13} />
      </button>
    </div>
  );
}
