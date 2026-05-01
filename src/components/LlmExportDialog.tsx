import { createSignal, For, Show } from "solid-js";
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
  const [skipNonApi, setSkipNonApi] = createSignal(true);
  const [maxBodyKb, setMaxBodyKb] = createSignal(4);
  const [busy, setBusy] = createSignal(false);
  const [savedPath, setSavedPath] = createSignal<string | null>(null);
  const [savedContent, setSavedContent] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const onLangChange = (id: string) => {
    const label = LLM_TARGET_LANGUAGES.find((l) => l.id === id)?.label ?? id;
    setLang(id);
    setPrompt(DEFAULT_LLM_PROMPT(label));
  };

  const onExport = async () => {
    const flows = props.flows();
    if (flows.length === 0) return;
    const opts: LlmExportOptions = {
      prompt: prompt(),
      targetLanguage: lang(),
      redactSecrets: redact(),
      skipNonApiBodies: skipNonApi(),
      maxBodyChars: Math.max(0, Math.floor(maxBodyKb() * 1024)),
    };
    const path = await save({
      defaultPath: "tucano.llm.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const content = toLlmMarkdown(flows, opts);
      await ipc.writeTextFile(path, content);
      setSavedPath(path);
      setSavedContent(content);
    } catch (e) {
      console.error("llm export failed", e);
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    const c = savedContent();
    if (!c) return;
    try {
      await navigator.clipboard.writeText(c);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error(e);
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
        <Show
          when={!savedPath()}
          fallback={
            <div>
              <div class="text-base font-semibold mb-2">
                {t("tb.export.llm.success.title")}
              </div>
              <div class="text-xs opacity-70 mb-4 break-all">{savedPath()}</div>
              <div class="rounded-xl bg-ink-50 dark:bg-ink-600/50 p-3 text-xs leading-relaxed mb-4">
                <div class="font-medium mb-1">
                  {t("tb.export.llm.success.howto")}
                </div>
                <ol class="list-decimal pl-4 space-y-0.5 opacity-80">
                  <li>{t("tb.export.llm.success.step1")}</li>
                  <li>{t("tb.export.llm.success.step2")}</li>
                  <li>{t("tb.export.llm.success.step3")}</li>
                </ol>
              </div>
              <div class="flex gap-2 justify-end">
                <button
                  onClick={onCopy}
                  class="h-8 px-3 rounded-xl text-xs bg-toucan-400/15 text-toucan-400 hover:bg-toucan-400/25 transition"
                >
                  {copied() ? t("tb.export.llm.success.copied") : t("tb.export.llm.success.copy")}
                </button>
                <button
                  onClick={props.onClose}
                  class="h-8 px-3 rounded-xl text-xs hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
                >
                  {t("tb.export.llm.success.close")}
                </button>
              </div>
            </div>
          }
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
              checked={skipNonApi()}
              onChange={(e) => setSkipNonApi(e.currentTarget.checked)}
            />
            {t("tb.export.llm.skipNonApi")}
          </label>

          <label class="flex items-center gap-2 text-xs mb-4">
            <span class="flex-1">{t("tb.export.llm.maxBodyKb")}</span>
            <input
              type="number"
              min={0}
              max={1024}
              step={1}
              value={maxBodyKb()}
              onInput={(e) => setMaxBodyKb(Number(e.currentTarget.value) || 0)}
              class="w-20 h-7 px-2 rounded-lg bg-ink-50 dark:bg-ink-600/60 border border-ink-100 dark:border-ink-400/40 text-xs"
            />
          </label>

          <div class="flex gap-2 justify-end">
            <button
              onClick={props.onClose}
              class="h-8 px-3 rounded-xl text-xs hover:bg-ink-100 dark:hover:bg-ink-400/20 transition"
            >
              {t("dlg.cancel")}
            </button>
            <button
              onClick={onExport}
              disabled={busy() || props.flows().length === 0}
              class="h-8 px-4 rounded-xl text-xs bg-toucan-400 text-white hover:bg-toucan-400/90 disabled:opacity-40 transition"
            >
              {t("tb.export.llm.cta")}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
