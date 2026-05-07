import { createSignal, For } from "solid-js";
import { save } from "@tauri-apps/plugin-dialog";
import {
  toLlmMarkdown,
  LLM_TARGET_LANGUAGES,
  DEFAULT_LLM_PROMPT,
  type LlmExportOptions,
} from "../lib/exporters";
import type { Flow } from "../lib/types";
import { ipc } from "../lib/ipc";
import { t } from "../lib/i18n";

type Props = {
  flows: () => Flow[];
  onClose: () => void;
};

export default function LlmExportDialog(props: Props) {
  const [lang, setLang] = createSignal(LLM_TARGET_LANGUAGES[0].id);
  const [prompt, setPrompt] = createSignal(
    DEFAULT_LLM_PROMPT(LLM_TARGET_LANGUAGES[0].label),
  );
  const [redact, setRedact] = createSignal(true);
  const [structured, setStructured] = createSignal(true);
  const [responseBodies, setResponseBodies] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [toast, setToast] = createSignal<string | null>(null);

  const onLangChange = (id: string) => {
    const label = LLM_TARGET_LANGUAGES.find((l) => l.id === id)?.label ?? id;
    setLang(id);
    setPrompt(DEFAULT_LLM_PROMPT(label));
  };

  const buildContent = (): string | null => {
    const flows = props.flows();
    if (flows.length === 0) return null;
    const opts: LlmExportOptions = {
      prompt: prompt(),
      targetLanguage: lang(),
      redactSecrets: redact(),
      includeStructuredSteps: structured(),
      includeResponseBodies: responseBodies(),
    };
    return toLlmMarkdown(flows, opts);
  };

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const onCopy = async () => {
    const content = buildContent();
    if (content == null) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(content);
      flashToast(t("tb.export.llm.copied"));
    } catch (e) {
      console.error("llm copy failed", e);
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    const content = buildContent();
    if (content == null) return;
    const path = await save({
      defaultPath: "tucano.llm.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      await ipc.writeTextFile(path, content);
      flashToast(t("tb.export.llm.savedToast", { path }));
    } catch (e) {
      console.error("llm save failed", e);
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        class="w-[560px] max-w-[92vw] bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-2xl p-5 text-sm"
      >
        <div class="text-base font-semibold mb-1">
          {t("tb.export.llm.title")}
        </div>
        <div class="text-xs opacity-60 mb-4">
          {t("tb.export.llm.subtitle", { n: props.flows().length })}
        </div>

        <label class="block text-xs font-medium mb-1">
          {t("tb.export.llm.lang")}
        </label>
        <select
          value={lang()}
          onChange={(e) => onLangChange(e.currentTarget.value)}
          class="w-full h-8 px-2 rounded-lg bg-ink-50 dark:bg-ink-600/60 border border-ink-100 dark:border-ink-400/40 text-xs mb-3"
        >
          <For each={LLM_TARGET_LANGUAGES}>
            {(l) => <option value={l.id}>{l.label}</option>}
          </For>
        </select>

        <label class="block text-xs font-medium mb-1">
          {t("tb.export.llm.prompt")}
        </label>
        <textarea
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          rows={5}
          class="w-full p-2 rounded-lg bg-ink-50 dark:bg-ink-600/60 border border-ink-100 dark:border-ink-400/40 text-xs font-mono mb-3 resize-y"
        />

        <label class="flex items-center gap-2 text-xs mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={redact()}
            onChange={(e) => setRedact(e.currentTarget.checked)}
          />
          {t("tb.export.llm.redact")}
        </label>

        <label class="flex items-center gap-2 text-xs mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={structured()}
            onChange={(e) => setStructured(e.currentTarget.checked)}
          />
          {t("tb.export.llm.structured")}
        </label>

        <label class="flex items-center gap-2 text-xs mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={responseBodies()}
            onChange={(e) => setResponseBodies(e.currentTarget.checked)}
          />
          {t("tb.export.llm.responseBodies")}
        </label>

        <div class="flex items-center gap-2 justify-end">
          <span class="flex-1 text-xs opacity-70 truncate">{toast() ?? ""}</span>
          <button
            onClick={props.onClose}
            class="h-8 px-3 rounded-xl text-xs hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
          >
            {t("dlg.cancel")}
          </button>
          <button
            onClick={onSave}
            disabled={busy() || props.flows().length === 0}
            class="h-8 px-3 rounded-xl text-xs bg-toucan-400/15 text-toucan-400 hover:bg-toucan-400/25 disabled:opacity-40 transition"
          >
            {t("tb.export.llm.cta.save")}
          </button>
          <button
            onClick={onCopy}
            disabled={busy() || props.flows().length === 0}
            class="h-8 px-4 rounded-xl text-xs bg-toucan-400 text-white hover:bg-toucan-400/90 disabled:opacity-40 transition"
          >
            {t("tb.export.llm.cta.copy")}
          </button>
        </div>
      </div>
    </div>
  );
}
