import { Copy, Check } from "lucide-solid";
import { createSignal, For } from "solid-js";
import { t } from "../lib/i18n";

export default function HeadersView(props: { headers: [string, string][] }) {
  const [copied, setCopied] = createSignal<string | null>(null);

  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {}
  };

  if (props.headers.length === 0) {
    return <div class="px-5 py-3 text-xs opacity-50 mono">{t("ins.noHeaders")}</div>;
  }

  return (
    <table class="w-full text-xs mono">
      <tbody>
        <For each={props.headers}>{([k, v], i) => {
          const lineId = `l${i()}`;
          const valId = `v${i()}`;
          const keyId = `k${i()}`;
          const btn = "h-6 px-2 rounded-md text-[10px] flex items-center gap-1 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 hover:border-toucan-400 hover:text-toucan-400";
          return (
            <tr class="group border-b border-ink-100/40 dark:border-ink-400/20 hover:bg-toucan-400/5">
              <td class="px-5 py-2.5 align-top text-toucan-400 w-1/3 break-all whitespace-pre-wrap">{k}</td>
              <td class="px-5 py-2.5 align-top break-all whitespace-pre-wrap relative">
                <div class="flex gap-2">
                  <span class="flex-1 min-w-0 break-all">{v}</span>
                  <span class="flex gap-1 opacity-0 group-hover:opacity-100 transition shrink-0 self-start sticky top-0">
                    <button onClick={() => copy(keyId, k)} title="Copy key" class={btn}>
                      {copied() === keyId ? <Check size={11} /> : <Copy size={11} />} key
                    </button>
                    <button onClick={() => copy(valId, v)} title="Copy value" class={btn}>
                      {copied() === valId ? <Check size={11} /> : <Copy size={11} />} value
                    </button>
                    <button onClick={() => copy(lineId, `${k}: ${v}`)} title="Copy full line" class={btn}>
                      {copied() === lineId ? <Check size={11} /> : <Copy size={11} />} line
                    </button>
                  </span>
                </div>
              </td>
            </tr>
          );
        }}</For>
      </tbody>
    </table>
  );
}
