import { useState } from "react";
import { X, Bot, Languages, MessageSquareText, SlidersHorizontal, Copy, Download, ChevronDown } from "lucide-react";
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

  const count = flows().length;

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[600px] max-w-[92vw] max-h-[86vh] flex flex-col rounded-2xl bg-white dark:bg-[var(--tcn-canvas)] text-ink-500 dark:text-ink-50 border border-ink-100 dark:border-white/10 shadow-2xl overflow-hidden"
      >
        {/* Header — mirrors the Settings dialog: brand mark, grid + radial glow */}
        <div className="relative shrink-0 border-b border-ink-100 dark:border-white/10 overflow-hidden">
          <div className="absolute inset-0 tcn-grid opacity-50 pointer-events-none" />
          <div className="absolute inset-0 tcn-glow-radial pointer-events-none" />
          <div className="relative flex items-center justify-between px-5 h-16">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 grid place-items-center rounded-xl tcn-sheen ring-1 ring-inset ring-ink-200/50 dark:ring-white/10 shadow-soft">
                <Bot size={18} className="text-toucan-400" />
              </div>
              <div className="leading-none">
                <div className="font-bold tracking-tight text-base">{t("tb.export.llm.title")}</div>
                <div className="text-[11px] opacity-50 mt-1.5">{t("tb.export.llm.subtitle", { n: count })}</div>
              </div>
            </div>
            <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-lg opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-white/10 transition"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto scroll-thin">
          <Section icon={<Languages size={14} />} title={t("tb.export.llm.lang")}>
            <div className="relative w-full">
              <select
                value={lang}
                onChange={(e) => onLangChange(e.currentTarget.value)}
                className="appearance-none w-full h-10 pl-3.5 pr-9 text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 focus:border-toucan-400 outline-none cursor-pointer"
              >
                {LLM_TARGET_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
            </div>
          </Section>

          <Section icon={<MessageSquareText size={14} />} title={t("tb.export.llm.prompt")}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              rows={5}
              className="w-full px-3 py-2 mono text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
            />
          </Section>

          <Section icon={<SlidersHorizontal size={14} />} title={t("tb.export.llm.cta")}>
            <Row title={t("tb.export.llm.redact")}>
              <Toggle checked={redact} onChange={setRedact} label={t("tb.export.llm.redact")} />
            </Row>
            <Row title={t("tb.export.llm.structured")}>
              <Toggle checked={structured} onChange={setStructured} label={t("tb.export.llm.structured")} />
            </Row>
            <Row title={t("tb.export.llm.responseBodies")}>
              <Toggle checked={responseBodies} onChange={setResponseBodies} label={t("tb.export.llm.responseBodies")} />
            </Row>
          </Section>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-ink-100 dark:border-white/10">
          <span className="flex-1 text-xs text-toucan-400 truncate">{toast ?? ""}</span>
          <button onClick={onClose} className="h-9 px-4 rounded-xl text-xs border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 transition">{t("dlg.cancel")}</button>
          <button onClick={onSaveFile} disabled={busy || count === 0} className="h-9 px-4 rounded-xl text-xs border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 disabled:opacity-40 flex items-center gap-1.5 transition"><Download size={13} /> {t("tb.export.llm.cta.save")}</button>
          <button onClick={onCopy} disabled={busy || count === 0} className="h-9 px-4 rounded-xl text-xs tcn-accent tcn-accent-glow disabled:opacity-40 flex items-center gap-1.5"><Copy size={13} /> {t("tb.export.llm.cta.copy")}</button>
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-ink-100 dark:border-ink-400/20 last:border-0 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-toucan-400"><span>{icon}</span><span className="text-xs uppercase tracking-wider font-semibold">{title}</span></div>
      {children}
    </div>
  );
}

function Row({ icon, title, hint, children }: { icon?: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      {icon && <div className="mt-1 opacity-70">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="text-sm leading-relaxed">{title}</div>
        {hint && <div className="text-xs opacity-60 mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-toucan-400/60 ${checked ? "bg-toucan-400" : "bg-ink-200 dark:bg-ink-400/40"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transform transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}
