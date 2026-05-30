import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Globe, AppWindow, X, PanelLeftClose, Layers, EyeOff } from "lucide-react";
import { useFlows } from "@/stores/flows";
import { useSidebar } from "@/stores/sidebar";
import { useIgnored } from "@/stores/ignored";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { CATEGORIES, matchesCategory, type Category } from "@/lib/category";
import type { Flow } from "@/lib/types";

// Drop all flows currently in the list that match a predicate, both from the
// UI store and from Rust storage.
function purgeMatching(predicate: (f: Flow) => boolean) {
  const ids: string[] = [];
  for (const f of useFlows.getState().flowsView) {
    if (predicate(f)) ids.push(f.id);
  }
  if (ids.length === 0) return;
  useFlows.getState().removeMany(new Set(ids));
  ipc.deleteFlows(ids).catch(() => {});
}

const CAT_DOT: Record<Category, string> = {
  all: "bg-toucan-400", http: "bg-cyan-300", https: "bg-emerald-400", websocket: "bg-fuchsia-400",
  json: "bg-amber-400", form: "bg-teal-400", xml: "bg-orange-400", js: "bg-yellow-400",
  css: "bg-pink-400", graphql: "bg-fuchsia-500", document: "bg-indigo-300", media: "bg-violet-400",
  other: "bg-ink-200",
};

export default function Sidebar() {
  const flowsView = useFlows((s) => s.flowsView);
  const selApps = useSidebar((s) => s.selectedApps);
  const selDomains = useSidebar((s) => s.selectedDomains);
  const selCats = useSidebar((s) => s.selectedCategories);
  const width = useSidebar((s) => s.width);
  const ignApps = useIgnored((s) => s.apps);
  const ignHosts = useIgnored((s) => s.hosts);
  const ignTypes = useIgnored((s) => s.types);

  const groups = useMemo(() => {
    const apps = new Map<string, { count: number; icon: string | null }>();
    const domains = new Map<string, number>();
    const cats = new Map<string, number>();
    const catIds = CATEGORIES.filter((c) => c.id !== "all").map((c) => c.id);
    for (const f of flowsView) {
      const name = f.clientApp || t("sidebar.unknownApp");
      const cur = apps.get(name);
      if (cur) cur.count++;
      else apps.set(name, { count: 1, icon: f.clientIcon ?? null });
      domains.set(f.host, (domains.get(f.host) ?? 0) + 1);
      for (const cid of catIds) {
        if (matchesCategory(f, cid)) cats.set(cid, (cats.get(cid) ?? 0) + 1);
      }
    }
    const appList = [...apps.entries()].map(([name, v]) => ({ name, count: v.count, icon: v.icon })).sort((a, b) => b.count - a.count);
    const domainList = [...domains.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count);
    const catList = CATEGORIES.filter((c) => c.id !== "all" && cats.has(c.id)).map((c) => ({ id: c.id as Category, count: cats.get(c.id)! }));
    return { apps: appList, domains: domainList, cats: catList };
  }, [flowsView]);

  const totalSelected = selApps.size + selDomains.size + selCats.size;
  const sb = useSidebar.getState();
  const ig = useIgnored.getState();

  return (
    <aside
      style={{ width: `${width}px` }}
      className="shrink-0 border-r border-ink-100/40 dark:border-white/[0.06] tcn-glass tcn-sheen flex flex-col overflow-hidden"
    >
      {/* Editorial header — eyebrow + Newsreader-italic title. */}
      <div className="relative px-4 pt-4 pb-3 flex items-end gap-2 border-b border-ink-100/50 dark:border-white/[0.06]">
        <div className="absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-toucan-400/40 via-toucan-400/10 to-transparent pointer-events-none" />
        <div className="flex-1 leading-none">
          <div className="text-[9px] uppercase tracking-[0.2em] text-toucan-400/80 mb-1.5 font-semibold">Tucano Proxy</div>
          <div className="font-accent text-[19px] leading-none tracking-tight">{t("sidebar.title")}</div>
        </div>
        {totalSelected > 0 && (
          <button
            onClick={() => sb.clear()}
            className="mb-0.5 text-[10px] mono px-2 h-6 rounded-lg ring-1 ring-inset ring-red-500/30 text-red-500 hover:bg-red-500/10 flex items-center gap-1 transition"
            title={t("sidebar.clearSelection")}
          ><X size={10} /> {totalSelected}</button>
        )}
        <button
          onClick={() => sb.setOpen(false)}
          className="mb-0.5 h-6 w-6 grid place-items-center rounded-lg opacity-55 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-white/[0.06] transition"
          title={t("sidebar.toggle")}
        ><PanelLeftClose size={12} /></button>
      </div>

      <div className="flex-1 overflow-auto py-1">
        <Section icon={<AppWindow size={12} className="text-muted-foreground" />} label={t("sidebar.apps")} count={groups.apps.length} storeKey="apps">
          {groups.apps.map((a) => (
            <Row
              key={a.name}
              icon={a.icon ? <img src={a.icon} alt="" className="w-3.5 h-3.5 rounded-sm" /> : <AppWindow size={12} className="opacity-40" />}
              label={a.name}
              count={a.count}
              selected={selApps.has(a.name)}
              onClick={(additive) => sb.toggleApp(a.name, additive)}
              hoverAction={{ icon: <EyeOff size={11} />, title: t("sidebar.ignoreApp"), onClick: () => { ig.addApp(a.name); purgeMatching((f) => (f.clientApp ?? "") === a.name); } }}
            />
          ))}
        </Section>

        <Section icon={<Globe size={12} className="text-muted-foreground" />} label={t("sidebar.domains")} count={groups.domains.length} storeKey="domains">
          {groups.domains.map((d) => (
            <Row
              key={d.host}
              icon={<Globe size={12} className="opacity-40" />}
              label={d.host}
              count={d.count}
              selected={selDomains.has(d.host)}
              onClick={(additive) => sb.toggleDomain(d.host, additive)}
              hoverAction={{ icon: <EyeOff size={11} />, title: t("sidebar.ignoreHost"), onClick: () => { ig.addHost(d.host); purgeMatching((f) => f.host === d.host); } }}
            />
          ))}
        </Section>

        <Section icon={<Layers size={12} className="text-muted-foreground" />} label={t("sidebar.types")} count={groups.cats.length} storeKey="cats">
          {groups.cats.map((c) => (
            <Row
              key={c.id}
              icon={<span className={`h-1.5 w-1.5 rounded-full ${CAT_DOT[c.id]}`} />}
              label={t(`cat.${c.id}`)}
              count={c.count}
              selected={selCats.has(c.id)}
              onClick={(additive) => sb.toggleCategory(c.id, additive)}
              hoverAction={{
                icon: <EyeOff size={11} />,
                title: t("sidebar.ignoreType"),
                onClick: () => { ig.addType(c.id); purgeMatching((f) => matchesCategory(f, c.id)); },
              }}
            />
          ))}
        </Section>

        {ignApps.size + ignHosts.size + ignTypes.size > 0 && (
          <Section
            icon={<EyeOff size={12} className="text-red-400" />}
            label={t("sidebar.ignored")}
            count={ignApps.size + ignHosts.size + ignTypes.size}
            storeKey="ignored"
            accent="text-red-400"
            headerAction={{ icon: <X size={10} />, title: t("sidebar.ignoredClearAll"), onClick: () => ig.clear() }}
          >
            {[...ignTypes].map((id) => (
              <Row key={`t-${id}`} icon={<span className={`h-1.5 w-1.5 rounded-full ${CAT_DOT[id as Category] ?? "bg-ink-200"}`} />} label={t(`cat.${id}`)} selected={false} onClick={() => ig.removeType(id)} hoverAction={{ icon: <X size={11} />, title: t("sidebar.unignore"), onClick: () => ig.removeType(id) }} />
            ))}
            {[...ignApps].map((name) => (
              <Row key={`a-${name}`} icon={<AppWindow size={12} className="opacity-40" />} label={name} selected={false} onClick={() => ig.removeApp(name)} hoverAction={{ icon: <X size={11} />, title: t("sidebar.unignore"), onClick: () => ig.removeApp(name) }} />
            ))}
            {[...ignHosts].map((host) => (
              <Row key={`h-${host}`} icon={<Globe size={12} className="opacity-40" />} label={host} selected={false} onClick={() => ig.removeHost(host)} hoverAction={{ icon: <X size={11} />, title: t("sidebar.unignore"), onClick: () => ig.removeHost(host) }} />
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

type SectionAction = { icon: React.ReactNode; title: string; onClick: () => void };

function Section({ icon, label, count, storeKey, accent, children, headerAction }: {
  icon: React.ReactNode; label: string; count: number; storeKey: string; accent?: string; children: React.ReactNode; headerAction?: SectionAction;
}) {
  const KEY = `tucano:sidebar:section:${storeKey}`;
  const [open, setOpenState] = useState(localStorage.getItem(KEY) !== "0");
  const setOpen = (v: boolean) => { setOpenState(v); localStorage.setItem(KEY, v ? "1" : "0"); };
  void accent;
  return (
    <div className="mb-1.5 group/sec">
      <div className="w-full pl-2.5 pr-2.5 py-2 flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="flex-1 flex items-center gap-2 text-left min-w-0">
          {open
            ? <ChevronDown size={12} className="opacity-35 shrink-0" />
            : <ChevronRight size={12} className="opacity-35 shrink-0" />}
          <span className="flex items-center gap-2 text-[12px] font-semibold tracking-tight text-foreground/85 dark:text-ink-50/90 truncate">
            {icon} {label}
          </span>
        </button>
        {headerAction && (
          <button
            onClick={(e) => { e.stopPropagation(); headerAction.onClick(); }}
            title={headerAction.title}
            className="h-5 w-5 grid place-items-center rounded-md opacity-0 group-hover/sec:opacity-60 hover:opacity-100 hover:bg-red-500/15 hover:text-red-400 transition"
          >{headerAction.icon}</button>
        )}
        <span className="text-[10px] mono tabular-nums px-1.5 py-px rounded-md bg-ink-100/70 dark:bg-white/[0.05] text-foreground/50 dark:text-ink-100/60 shrink-0">{count}</span>
      </div>
      {open && <div className="pb-0.5">{children}</div>}
    </div>
  );
}

type RowAction = { icon: React.ReactNode; title: string; onClick: () => void };

function Row({ icon, label, count, selected, onClick, hoverAction }: {
  icon: React.ReactNode; label: string; count?: number; selected: boolean; onClick: (additive: boolean) => void; hoverAction?: RowAction;
}) {
  return (
    <div
      className={`group/row w-full pl-7 pr-2.5 py-[5px] flex items-center gap-2 text-xs transition relative cursor-pointer
        ${selected
          ? "bg-gradient-to-r from-toucan-400/22 via-toucan-400/8 to-transparent text-toucan-600 dark:text-toucan-300 font-semibold shadow-[inset_2px_0_0_0_rgb(106_87_224)]"
          : "hover:bg-ink-100/50 dark:hover:bg-white/[0.04] text-foreground/80 dark:text-ink-50/85"}`}
      title={label}
      onClick={(e) => onClick(e.metaKey || e.ctrlKey || e.shiftKey)}
    >
      <span className="shrink-0 grid place-items-center w-3.5">{icon}</span>
      <span className="flex-1 truncate mono text-[11px]">{label}</span>
      {hoverAction && (
        <button
          onClick={(e) => { e.stopPropagation(); hoverAction.onClick(); }}
          title={hoverAction.title}
          className="h-5 w-5 grid place-items-center rounded-md opacity-0 group-hover/row:opacity-60 hover:opacity-100 hover:bg-red-500/15 hover:text-red-400 transition"
        >{hoverAction.icon}</button>
      )}
      {count !== undefined && <span className="text-[10px] opacity-45 mono tabular-nums shrink-0">{count}</span>}
    </div>
  );
}
