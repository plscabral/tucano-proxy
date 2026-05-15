import { createMemo, createSignal, For, Show } from "solid-js";
import { ChevronRight, ChevronDown, Globe, AppWindow, X, PanelLeftClose, Layers, EyeOff } from "lucide-solid";
import { flowsStore } from "../stores/flows";
import { sidebarStore } from "../stores/sidebar";
import { ignoredStore } from "../stores/ignored";
import { ipc } from "../lib/ipc";
import { t } from "../lib/i18n";
import { CATEGORIES, matchesCategory, type Category } from "../lib/category";
import type { Flow } from "../lib/types";

// Drop all flows currently in the list that match a predicate, both from
// the UI store and from Rust storage. Used when the user adds something to
// the ignore list — without this retroactive pass, existing rows would
// stick around until the user reloads.
function purgeMatching(predicate: (f: Flow) => boolean) {
  const ids: string[] = [];
  for (const f of flowsStore.flows()) {
    if (predicate(f)) ids.push(f.id);
  }
  if (ids.length === 0) return;
  flowsStore.removeMany(new Set(ids));
  ipc.deleteFlows(ids).catch(() => {});
}

const CAT_DOT: Record<Category, string> = {
  all:       "bg-toucan-400",
  http:      "bg-cyan-300",
  https:     "bg-emerald-400",
  websocket: "bg-fuchsia-400",
  json:      "bg-amber-400",
  form:      "bg-teal-400",
  xml:       "bg-orange-400",
  js:        "bg-yellow-400",
  css:       "bg-pink-400",
  graphql:   "bg-fuchsia-500",
  document:  "bg-indigo-300",
  media:     "bg-violet-400",
  other:     "bg-ink-200",
};

export default function Sidebar() {
  // Group counts derived from the live flow list. Re-runs only when flows
  // change, not on every selection toggle.
  const groups = createMemo(() => {
    const apps = new Map<string, { count: number; icon: string | null }>();
    const domains = new Map<string, number>();
    const cats = new Map<string, number>();
    const flows = flowsStore.flows();
    for (const f of flows) {
      const name = f.clientApp || t("sidebar.unknownApp");
      const cur = apps.get(name);
      if (cur) cur.count++;
      else apps.set(name, { count: 1, icon: f.clientIcon ?? null });
      domains.set(f.host, (domains.get(f.host) ?? 0) + 1);
    }
    // Categories use matchesCategory so the counts mirror exactly what the
    // filter would yield. Skip "all" — it's the no-op state.
    for (const c of CATEGORIES) {
      if (c.id === "all") continue;
      const n = flows.reduce((acc, f) => acc + (matchesCategory(f, c.id) ? 1 : 0), 0);
      if (n > 0) cats.set(c.id, n);
    }
    const appList = [...apps.entries()]
      .map(([name, v]) => ({ name, count: v.count, icon: v.icon }))
      .sort((a, b) => b.count - a.count);
    const domainList = [...domains.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count);
    // Preserve the CATEGORIES authoring order so JSON/Form/XML stay grouped.
    const catList = CATEGORIES
      .filter((c) => c.id !== "all" && cats.has(c.id))
      .map((c) => ({ id: c.id as Category, count: cats.get(c.id)! }));
    return { apps: appList, domains: domainList, cats: catList };
  });

  const totalSelected = () =>
    sidebarStore.selectedApps().size + sidebarStore.selectedDomains().size + sidebarStore.selectedCategories().size;

  return (
    <aside
      style={{ width: `${sidebarStore.width()}px` }}
      class="shrink-0 border-r border-ink-100/40 dark:border-white/[0.05] tcn-glass flex flex-col overflow-hidden"
    >
      <div class="px-3 py-2 flex items-center gap-2 border-b border-ink-100/40 dark:border-white/[0.05]">
        <div class="text-[11px] uppercase tracking-wider opacity-60 mono flex-1">
          {t("sidebar.title")}
        </div>
        <Show when={totalSelected() > 0}>
          <button
            onClick={() => sidebarStore.clear()}
            class="text-[10px] px-2 py-1 rounded-lg hover:bg-red-500/10 hover:text-red-500 flex items-center gap-1"
            title={t("sidebar.clearSelection")}
          ><X size={10} /> {totalSelected()}</button>
        </Show>
        <button
          onClick={() => sidebarStore.setOpen(false)}
          class="h-6 w-6 grid place-items-center rounded-lg opacity-60 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-400/20"
          title={t("sidebar.toggle")}
        ><PanelLeftClose size={12} /></button>
      </div>

      <div class="flex-1 overflow-auto py-1">
        <Section
          icon={<AppWindow size={12} class="text-sky-400" />}
          label={t("sidebar.apps")}
          count={groups().apps.length}
          storeKey="apps"
          accent="text-sky-400"
        >
          <For each={groups().apps}>{(a) => (
            <Row
              icon={a.icon ? <img src={a.icon} alt="" class="w-3.5 h-3.5 rounded-sm" /> : <AppWindow size={12} class="opacity-40" />}
              label={a.name}
              count={a.count}
              selected={sidebarStore.selectedApps().has(a.name)}
              onClick={(additive) => sidebarStore.toggleApp(a.name, additive)}
              hoverAction={{
                icon: <EyeOff size={11} />,
                title: t("sidebar.ignoreApp"),
                onClick: () => {
                  ignoredStore.addApp(a.name);
                  purgeMatching((f) => (f.clientApp ?? "") === a.name);
                },
              }}
            />
          )}</For>
        </Section>

        <Section
          icon={<Globe size={12} class="text-emerald-400" />}
          label={t("sidebar.domains")}
          count={groups().domains.length}
          storeKey="domains"
          accent="text-emerald-400"
        >
          <For each={groups().domains}>{(d) => (
            <Row
              icon={<Globe size={12} class="opacity-40" />}
              label={d.host}
              count={d.count}
              selected={sidebarStore.selectedDomains().has(d.host)}
              onClick={(additive) => sidebarStore.toggleDomain(d.host, additive)}
              hoverAction={{
                icon: <EyeOff size={11} />,
                title: t("sidebar.ignoreHost"),
                onClick: () => {
                  ignoredStore.addHost(d.host);
                  purgeMatching((f) => f.host === d.host);
                },
              }}
            />
          )}</For>
        </Section>

        <Section
          icon={<Layers size={12} class="text-amber-400" />}
          label={t("sidebar.types")}
          count={groups().cats.length}
          storeKey="cats"
          accent="text-amber-400"
        >
          <For each={groups().cats}>{(c) => (
            <Row
              icon={<span class={`h-1.5 w-1.5 rounded-full ${CAT_DOT[c.id]}`} />}
              label={t(`cat.${c.id}`)}
              count={c.count}
              selected={sidebarStore.selectedCategories().has(c.id)}
              onClick={(additive) => sidebarStore.toggleCategory(c.id, additive)}
            />
          )}</For>
        </Section>

        <Show when={ignoredStore.apps().size + ignoredStore.hosts().size > 0}>
          <Section
            icon={<EyeOff size={12} class="text-red-400" />}
            label={t("sidebar.ignored")}
            count={ignoredStore.apps().size + ignoredStore.hosts().size}
            storeKey="ignored"
            accent="text-red-400"
            headerAction={{
              icon: <X size={10} />,
              title: t("sidebar.ignoredClearAll"),
              onClick: () => ignoredStore.clear(),
            }}
          >
            <For each={[...ignoredStore.apps()]}>{(name) => (
              <Row
                icon={<AppWindow size={12} class="opacity-40" />}
                label={name}
                selected={false}
                onClick={() => ignoredStore.removeApp(name)}
                hoverAction={{
                  icon: <X size={11} />,
                  title: t("sidebar.unignore"),
                  onClick: () => ignoredStore.removeApp(name),
                }}
              />
            )}</For>
            <For each={[...ignoredStore.hosts()]}>{(host) => (
              <Row
                icon={<Globe size={12} class="opacity-40" />}
                label={host}
                selected={false}
                onClick={() => ignoredStore.removeHost(host)}
                hoverAction={{
                  icon: <X size={11} />,
                  title: t("sidebar.unignore"),
                  onClick: () => ignoredStore.removeHost(host),
                }}
              />
            )}</For>
          </Section>
        </Show>
      </div>
    </aside>
  );
}

type SectionAction = { icon: any; title: string; onClick: () => void };

// Per-section open/closed state lives in localStorage so user collapses stick.
function Section(props: {
  icon: any; label: string; count: number; storeKey: string; accent?: string; children: any;
  headerAction?: SectionAction;
}) {
  const KEY = `tucano:sidebar:section:${props.storeKey}`;
  const [openSig, setOpenSig] = createSignal(localStorage.getItem(KEY) !== "0");
  const open = openSig;
  const setOpen = (v: boolean) => { setOpenSig(v); localStorage.setItem(KEY, v ? "1" : "0"); };
  return (
    <div class="mb-1 group/sec">
      <div class="w-full px-3 py-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider hover:bg-white/[0.03] transition">
        <button onClick={() => setOpen(!open())} class="flex-1 flex items-center gap-1.5 text-left">
          {open() ? <ChevronDown size={11} class="opacity-60" /> : <ChevronRight size={11} class="opacity-60" />}
          <span class={`flex items-center gap-1.5 font-semibold ${props.accent ?? ""}`}>{props.icon} {props.label}</span>
        </button>
        <Show when={props.headerAction}>
          {(a) => (
            <button
              onClick={(e) => { e.stopPropagation(); a().onClick(); }}
              title={a().title}
              class="h-5 w-5 grid place-items-center rounded-md opacity-0 group-hover/sec:opacity-60 hover:opacity-100 hover:bg-red-500/15 hover:text-red-400 transition"
            >{a().icon}</button>
          )}
        </Show>
        <span class="opacity-50 normal-case tracking-normal mono">{props.count}</span>
      </div>
      <Show when={open()}>
        <div>{props.children}</div>
      </Show>
    </div>
  );
}

type RowAction = { icon: any; title: string; onClick: () => void };

function Row(props: {
  icon: any;
  label: string;
  count?: number;
  selected: boolean;
  onClick: (additive: boolean) => void;
  hoverAction?: RowAction;
}) {
  return (
    <div
      class={`group/row w-full px-3 py-1 pl-6 flex items-center gap-2 text-xs transition relative cursor-pointer
        ${props.selected
          ? "bg-gradient-to-r from-toucan-400/25 via-toucan-400/12 to-transparent text-toucan-600 dark:text-toucan-400 font-semibold"
          : "hover:bg-ink-100/50 dark:hover:bg-white/[0.04] text-ink-500 dark:text-ink-50"}`}
      title={props.label}
      onClick={(e) => props.onClick(e.metaKey || e.ctrlKey || e.shiftKey)}
    >
      {props.icon}
      <span class="flex-1 truncate mono">{props.label}</span>
      <Show when={props.hoverAction}>
        {(a) => (
          <button
            onClick={(e) => { e.stopPropagation(); a().onClick(); }}
            title={a().title}
            class="h-5 w-5 grid place-items-center rounded-md opacity-0 group-hover/row:opacity-60 hover:opacity-100 hover:bg-red-500/15 hover:text-red-400 transition"
          >{a().icon}</button>
        )}
      </Show>
      <Show when={props.count !== undefined}>
        <span class="text-[10px] opacity-50 mono">{props.count}</span>
      </Show>
    </div>
  );
}
