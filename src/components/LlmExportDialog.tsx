import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { toLlmMarkdown, LLM_TARGET_LANGUAGES, DEFAULT_LLM_PROMPT, type LlmExportOptions } from "@/lib/exporters";
import type { Flow } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { t } from "@/lib/i18n";

type Props = {
  flows: () => Flow[];
  onClose: () => void;
};

export default function LlmExportDialog({ flows, onClose }: Props) {
  const [lang, setLang] = useState(LLM_TARGET_LANGUAGES[0].id);
  const [prompt, setPrompt] = useState(DEFAULT_LLM_PROMPT(LLM_TARGET_LANGUAGES[0].label));
  const [redact, setRedact] = useState(true);
  const [structured, setStructured] = useState(true);
  const [responseBodies, setResponseBodies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const onLangChange = (id: string) => {
    const label = LLM_TARGET_LANGUAGES.find((l) => l.id === id)?.label ?? id;
    setLang(id);
    setPrompt(DEFAULT_LLM_PROMPT(label));
  };

  const buildContent = (): string | null => {
    const fl = flows();
    if (fl.length === 0) return null;
    const opts: LlmExportOptions = {
      prompt, targetLanguage: lang, redactSecrets: redact,
      includeStructuredSteps: structured, includeResponseBodies: responseBodies,
    };
    return toLlmMarkdown(fl, opts);
  };

  const flashToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 1800); };

  const onCopy = async () => {
    const content = buildContent();
    if (content == null) return;
    setBusy(true);
    try { await navigator.clipboard.writeText(content); flashToast(t("tb.export.llm.copied")); }
    catch (e) { console.error("llm copy failed", e); alert(String(e)); }
    finally { setBusy(false); }
  };

  const onSaveFile = async () => {
    const content = buildContent();
    if (content == null) return;
    const path = await save({ defaultPath: "tucano.llm.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    setBusy(true);
    try { await ipc.writeTextFile(path, content); flashToast(t("tb.export.llm.savedToast", { path })); }
    catch (e) { console.error("llm save failed", e); alert(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[92vw] bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-2xl shadow-2xl p-5 text-sm"
      >
        <div className="text-base font-semibold mb-1">{t("tb.export.llm.title")}</div>
        <div className="text-xs opacity-60 mb-4">{t("tb.export.llm.subtitle", { n: flows().length })}</div>

        <label className="block text-xs font-medium mb-1">{t("tb.export.llm.lang")}</label>
        <select
          value={lang}
          onChange={(e) => onLangChange(e.currentTarget.value)}
          className="w-full h-8 px-2 rounded-lg bg-ink-50 dark:bg-ink-600/60 border border-ink-100 dark:border-ink-400/40 text-xs mb-3"
        >
          {LLM_TARGET_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>

        <label className="block text-xs font-medium mb-1">{t("tb.export.llm.prompt")}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          rows={5}
          className="w-full p-2 rounded-lg bg-ink-50 dark:bg-ink-600/60 border border-ink-100 dark:border-ink-400/40 text-xs font-mono mb-3 resize-y"
        />

        <label className="flex items-center gap-2 text-xs mb-2 cursor-pointer">
          <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.currentTarget.checked)} />
          {t("tb.export.llm.redact")}
        </label>
        <label className="flex items-center gap-2 text-xs mb-2 cursor-pointer">
          <input type="checkbox" checked={structured} onChange={(e) => setStructured(e.currentTarget.checked)} />
          {t("tb.export.llm.structured")}
        </label>
        <label className="flex items-center gap-2 text-xs mb-4 cursor-pointer">
          <input type="checkbox" checked={responseBodies} onChange={(e) => setResponseBodies(e.currentTarget.checked)} />
          {t("tb.export.llm.responseBodies")}
        </label>

        <div className="flex items-center gap-2 justify-end">
          <span className="flex-1 text-xs opacity-70 truncate">{toast ?? ""}</span>
          <button onClick={onClose} className="h-8 px-3 rounded-xl text-xs hover:bg-ink-100 dark:hover:bg-ink-400/20 transition">{t("dlg.cancel")}</button>
          <button onClick={onSaveFile} disabled={busy || flows().length === 0} className="h-8 px-3 rounded-xl text-xs bg-toucan-400/15 text-toucan-400 hover:bg-toucan-400/25 disabled:opacity-40 transition">{t("tb.export.llm.cta.save")}</button>
          <button onClick={onCopy} disabled={busy || flows().length === 0} className="h-8 px-4 rounded-xl text-xs bg-toucan-400 text-white hover:bg-toucan-400/90 disabled:opacity-40 transition">{t("tb.export.llm.cta.copy")}</button>
        </div>
      </div>
    </div>
  );
}
