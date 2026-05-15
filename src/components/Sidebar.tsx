import { createMemo, createSignal, For, Show } from "solid-js";
import { ChevronRight, ChevronDown, Globe, AppWindow, X, PanelLeftClose } from "lucide-solid";
import { flowsStore } from "../stores/flows";
import { sidebarStore } from "../stores/sidebar";
import { t } from "../lib/i18n";
import type { Flow } from "../lib/types";

export default function Sidebar() {
  // Group counts derived from the live flow list. Re-runs only when flows
  // change, not on every selection toggle.
  const groups = createMemo(() => {
    const apps = new Map<string, { count: number; icon: string | null }>();
    const domains = new Map<string, number>();
    for (const f of flowsStore.flows()) {
      const name = f.clientApp || t("sidebar.unknownApp");
      const cur = apps.get(name);
      if (cur) cur.count++;
      else apps.set(name, { count: 1, icon: f.clientIcon ?? null });
      domains.set(f.host, (domains.get(f.host) ?? 0) + 1);
    }
    const appList = [...apps.entries()]
      .map(([name, v]) => ({ name, count: v.count, icon: v.icon }))
      .sort((a, b) => b.count - a.count);
    const domainList = [...domains.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count);
    return { apps: appList, domains: domainList };
  });

  const totalSelected = () =>
    sidebarStore.selectedApps().size + sidebarStore.selectedDomains().size;

  return (
    <aside
      style={{ width: `${sidebarStore.width()}px` }}
      class="shrink-0 border-r border-ink-100 dark:border-ink-400/40 bg-white dark:bg-ink-500 flex flex-col overflow-hidden"
    >
      <div class="px-3 py-2 flex items-center gap-2 border-b border-ink-100 dark:border-ink-400/30">
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
          icon={<AppWindow size={12} />}
          label={t("sidebar.apps")}
          count={groups().apps.length}
          storeKey="apps"
        >
          <For each={groups().apps}>{(a) => (
            <Row
              icon={a.icon ? <img src={a.icon} alt="" class="w-3.5 h-3.5 rounded-sm" /> : <AppWindow size={12} class="opacity-40" />}
              label={a.name}
              count={a.count}
              selected={sidebarStore.selectedApps().has(a.name)}
              onClick={(additive) => sidebarStore.toggleApp(a.name, additive)}
            />
          )}</For>
        </Section>

        <Section
          icon={<Globe size={12} />}
          label={t("sidebar.domains")}
          count={groups().domains.length}
          storeKey="domains"
        >
          <For each={groups().domains}>{(d) => (
            <Row
              icon={<Globe size={12} class="opacity-40" />}
              label={d.host}
              count={d.count}
              selected={sidebarStore.selectedDomains().has(d.host)}
              onClick={(additive) => sidebarStore.toggleDomain(d.host, additive)}
            />
          )}</For>
        </Section>
      </div>
    </aside>
  );
}

// Per-section open/closed state lives in localStorage so user collapses stick.
function Section(props: { icon: any; label: string; count: number; storeKey: string; children: any }) {
  const KEY = `tucano:sidebar:section:${props.storeKey}`;
  const [openSig, setOpenSig] = createSignal(localStorage.getItem(KEY) !== "0");
  const open = openSig;
  const setOpen = (v: boolean) => { setOpenSig(v); localStorage.setItem(KEY, v ? "1" : "0"); };
  return (
    <div class="mb-1">
      <button
        onClick={() => setOpen(!open())}
        class="w-full px-3 py-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wider opacity-70 hover:opacity-100"
      >
        {open() ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span class="flex items-center gap-1.5">{props.icon} {props.label}</span>
        <span class="ml-auto opacity-50 normal-case tracking-normal">{props.count}</span>
      </button>
      <Show when={open()}>
        <div>{props.children}</div>
      </Show>
    </div>
  );
}

function Row(props: {
  icon: any;
  label: string;
  count: number;
  selected: boolean;
  onClick: (additive: boolean) => void;
}) {
  return (
    <button
      onClick={(e) => props.onClick(e.metaKey || e.ctrlKey || e.shiftKey)}
      class={`w-full px-3 py-1 pl-6 flex items-center gap-2 text-xs text-left transition
        ${props.selected
          ? "bg-toucan-400/15 text-toucan-400"
          : "hover:bg-ink-50 dark:hover:bg-ink-400/20"}`}
      title={props.label}
    >
      {props.icon}
      <span class="flex-1 truncate mono">{props.label}</span>
      <span class="text-[10px] opacity-50 mono">{props.count}</span>
    </button>
  );
}
