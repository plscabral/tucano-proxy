import { Trash2, Save, FolderOpen, Tag, PanelRight, PanelBottom, EyeOff } from "lucide-solid";
import { layoutStore, type InspectorPos } from "../stores/layout";
import ColumnsMenu from "./ColumnsMenu";
import { save, open } from "@tauri-apps/plugin-dialog";
import { flowsStore } from "../stores/flows";
import { marksStore, MARK_COLORS } from "../stores/marks";
import { ipc } from "../lib/ipc";
import { createSignal, Show, For } from "solid-js";
import { t } from "../lib/i18n";

export default function FlowToolbar(props: { count: number }) {
  const [openMark, setOpenMark] = createSignal(false);

  const onSave = async () => {
    const path = await save({ defaultPath: "session.tucano", filters: [{ name: "Tucano Session", extensions: ["tucano"] }] });
    if (path) await ipc.saveSession(path);
  };
  const onOpen = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Tucano Session", extensions: ["tucano"] }] });
    if (path && typeof path === "string") {
      await ipc.openSession(path);
      flowsStore.setFlows(await ipc.listFlows());
    }
  };
  const clear = async () => {
    if (!confirm(t("tb.clearTitle"))) return;
    await ipc.clearFlows();
    flowsStore.clear();
    marksStore.clear();
  };
  const setMark = (colorId: string) => {
    flowsStore.selectedIds().forEach((id) => marksStore.set(id, colorId));
    setOpenMark(false);
  };
  const hasSelection = () => flowsStore.selectedIds().size > 0;

  function LayoutBtn(p: { pos: InspectorPos; titleKey: string; icon: any }) {
    const active = () => layoutStore.pos() === p.pos;
    return (
      <button
        onClick={() => layoutStore.setPos(p.pos)}
        title={t(p.titleKey)}
        class={`h-8 w-8 grid place-items-center rounded-xl transition
          ${active() ? "bg-toucan-400/15 text-toucan-400" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}
      >{p.icon}</button>
    );
  }

  return (
    <div class="h-11 px-3 flex items-center gap-1.5 bg-ink-50/60 dark:bg-ink-600 border-b border-ink-100 dark:border-ink-400/30 relative">
      <button onClick={clear} title={t("tb.clearTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-red-500/10 hover:text-red-500 transition">
        <Trash2 size={13} /> {t("tb.clear")}
      </button>

      <div class="relative">
        <button onClick={() => setOpenMark(!openMark())} disabled={!hasSelection()}
          title={t("tb.markTitle")}
          class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-toucan-400/10 hover:text-toucan-400 disabled:opacity-40 transition">
          <Tag size={13} /> {t("tb.mark")}
        </button>
        <Show when={openMark() && hasSelection()}>
          <div class="absolute z-30 top-10 left-0 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-xl p-1.5 flex gap-1">
            <For each={MARK_COLORS}>{(c) => (
              <button
                onClick={() => setMark(c.id)}
                title={t(`mark.${c.id}`)}
                class="h-8 w-8 rounded-lg grid place-items-center hover:bg-ink-50 dark:hover:bg-ink-400/20"
              >
                <span class={`block h-4 w-4 rounded-full ${c.id === "none" ? "border border-dashed border-current opacity-50" : ""}`}
                  style={{ background: c.color }} />
              </button>
            )}</For>
          </div>
        </Show>
      </div>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1.5" />

      <button onClick={onOpen} title={t("tb.openTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
        <FolderOpen size={13} /> {t("tb.open")}
      </button>
      <button onClick={onSave} title={t("tb.saveTitle")}
        class="h-8 px-3 rounded-xl text-xs flex items-center gap-1.5 hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">
        <Save size={13} /> {t("tb.save")}
      </button>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1.5" />
      <ColumnsMenu />

      <div class="flex-1" />
      <span class="text-[11px] opacity-50 mono pr-2">{t("tb.countOf", { count: props.count, total: flowsStore.flows().length })}</span>

      <div class="w-px h-5 bg-ink-100 dark:bg-ink-400/30 mx-1" />

      <LayoutBtn pos="right"  titleKey="tb.inspectorRight"  icon={<PanelRight size={14} />} />
      <LayoutBtn pos="bottom" titleKey="tb.inspectorBottom" icon={<PanelBottom size={14} />} />
      <LayoutBtn pos="hidden" titleKey="tb.inspectorHidden" icon={<EyeOff size={14} />} />
    </div>
  );
}
