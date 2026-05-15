import { Copy, Check, MoreHorizontal } from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { t } from "../lib/i18n";

export default function HeadersView(props: { headers: [string, string][] }) {
  const [copied, setCopied] = createSignal<string | null>(null);
  const [openRow, setOpenRow] = createSignal<number | null>(null);

  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setOpenRow(null);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {}
  };

  if (props.headers.length === 0) {
    return <div class="px-3 py-3 text-xs opacity-50 mono">{t("ins.noHeaders")}</div>;
  }

  return (
    <table class="w-full text-xs mono">
      <tbody>
        <For each={props.headers}>{([k, v], i) => {
          const lineId = `l${i()}`;
          const valId = `v${i()}`;
          const keyId = `k${i()}`;
          const item = "w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 hover:bg-toucan-400/10 hover:text-toucan-400";
          return (
            <tr class="group border-b border-ink-100/30 dark:border-white/[0.04] hover:bg-toucan-400/[0.04]">
              <td class="px-3 py-2 align-top w-1/3 [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-400 dark:text-ink-200/70 group-hover:text-toucan-500 dark:group-hover:text-toucan-400 transition-colors">{k}</td>
              <td class="px-3 py-2 align-top [overflow-wrap:anywhere] whitespace-pre-wrap relative text-ink-500 dark:text-ink-50">
                <div class="flex gap-2">
                  <span class="flex-1 min-w-0 [overflow-wrap:anywhere]">{v}</span>
                  <div class="relative shrink-0 self-start">
                    <button
                      onClick={() => setOpenRow(openRow() === i() ? null : i())}
                      title={t("ins.copy") || "Copy"}
                      class="h-6 w-6 grid place-items-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition"
                    ><MoreHorizontal size={13} /></button>
                    <Show when={openRow() === i()}>
                      <div class="fixed inset-0 z-30" onClick={() => setOpenRow(null)} />
                      <div class="absolute z-40 right-0 top-7 min-w-[140px] tcn-glass-strong rounded-xl shadow-elev py-1">
                        <button onClick={() => copy(keyId, k)} class={item}>
                          {copied() === keyId ? <Check size={11} /> : <Copy size={11} />} Copy key
                        </button>
                        <button onClick={() => copy(valId, v)} class={item}>
                          {copied() === valId ? <Check size={11} /> : <Copy size={11} />} Copy value
                        </button>
                        <button onClick={() => copy(lineId, `${k}: ${v}`)} class={item}>
                          {copied() === lineId ? <Check size={11} /> : <Copy size={11} />} Copy line
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              </td>
            </tr>
          );
        }}</For>
      </tbody>
    </table>
  );
}
