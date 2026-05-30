import { useState } from "react";
import { ShieldCheck, Globe, Sparkles, Check, ArrowRight, ArrowLeft, Zap, Lock, Filter } from "lucide-react";
import { useFlows } from "@/stores/flows";
import { ipc } from "@/lib/ipc";
import { t, LOCALES, useLocale, setLocale, type Locale } from "@/lib/i18n";

const STORAGE_KEY = "tucano:onboarded";

export function shouldShowOnboarding(): boolean {
  try { return !localStorage.getItem(STORAGE_KEY); } catch { return false; }
}

export default function Onboarding({ onClose }: { onClose: () => void }) {
  const TOTAL = 4;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);

  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch {}
    onClose();
  };
  const installCert = async () => {
    setBusy(true);
    try {
      await ipc.installCa();
      useFlows.getState().setStatus(await ipc.status());
    } finally { setBusy(false); }
  };
  const next = () => setStep((s) => Math.min(TOTAL - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 backdrop-blur-sm">
      <div className="w-[560px] max-w-[92vw] rounded-2xl bg-white dark:bg-ink-600 text-ink-500 dark:text-ink-50 border border-ink-100 dark:border-ink-400/40 shadow-2xl overflow-hidden">
        <div className="h-1 bg-ink-100 dark:bg-ink-400/30 relative">
          <div className="absolute inset-y-0 left-0 bg-toucan-400 transition-all duration-300" style={{ width: `${((step + 1) / TOTAL) * 100}%` }} />
        </div>

        <div className="px-8 pt-8 pb-6 min-h-[360px]">
          {step === 0 && <StepWelcome />}
          {step === 1 && <StepLanguage />}
          {step === 2 && <StepCertificate busy={busy} onInstall={installCert} />}
          {step === 3 && <StepTips />}
        </div>

        <div className="px-6 py-4 border-t border-ink-100 dark:border-ink-400/30 flex items-center justify-between bg-ink-50/50 dark:bg-ink-500/30">
          <div className="flex items-center gap-2">
            {Array.from({ length: TOTAL }).map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-toucan-400" : i < step ? "w-1.5 bg-toucan-400/60" : "w-1.5 bg-ink-200 dark:bg-ink-400/40"}`} />
            ))}
            <span className="ml-2 text-[11px] mono opacity-50">{t("ob.step", { n: step + 1, total: TOTAL })}</span>
          </div>

          <div className="flex items-center gap-2">
            {step === 0 && <button onClick={finish} className="h-9 px-3 text-xs opacity-60 hover:opacity-100 transition">{t("ob.skip")}</button>}
            {step > 0 && <button onClick={back} className="h-9 px-3 text-xs flex items-center gap-1 opacity-70 hover:opacity-100 transition"><ArrowLeft size={13} /> {t("ob.back")}</button>}
            {step < TOTAL - 1 && (
              <button onClick={next} className="h-9 px-4 text-xs rounded-xl bg-toucan-400 text-white font-medium hover:bg-toucan-300 flex items-center gap-1.5 transition">
                {t("ob.next")} <ArrowRight size={13} />
              </button>
            )}
            {step === TOTAL - 1 && (
              <button onClick={finish} className="h-9 px-4 text-xs rounded-xl bg-toucan-400 text-white font-medium hover:bg-toucan-300 flex items-center gap-1.5 transition">
                {t("ob.finish")} <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepWelcome() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative w-20 h-20 mb-6 grid place-items-center">
        <span className="absolute inset-0 rounded-2xl bg-toucan-400/15 rotate-6" />
        <span className="absolute inset-0 rounded-2xl bg-toucan-400/25 -rotate-3" />
        <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-toucan-300 to-toucan-400 grid place-items-center shadow-xl">
          <Sparkles size={32} className="text-white" />
        </div>
      </div>
      <h1 className="text-2xl font-bold tracking-tight mb-2">{t("ob.welcomeTitle")}</h1>
      <p className="text-sm opacity-70 max-w-md leading-relaxed mb-6">{t("ob.welcomeSubtitle")}</p>
      <div className="w-full flex flex-col gap-2.5 max-w-sm text-left">
        <Feature icon={<Zap size={14} />} text={t("ob.welcomeFeat1")} />
        <Feature icon={<Lock size={14} />} text={t("ob.welcomeFeat2")} />
        <Feature icon={<Filter size={14} />} text={t("ob.welcomeFeat3")} />
      </div>
    </div>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-ink-50 dark:bg-ink-500/40">
      <div className="w-7 h-7 rounded-lg bg-toucan-400/15 text-toucan-400 grid place-items-center shrink-0">{icon}</div>
      <span className="text-sm">{text}</span>
    </div>
  );
}

function StepLanguage() {
  const locale = useLocale((s) => s.locale);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-toucan-400/15 text-toucan-400 grid place-items-center"><Globe size={20} /></div>
        <div>
          <h2 className="text-lg font-semibold">{t("ob.langTitle")}</h2>
          <p className="text-xs opacity-60">{t("ob.langSubtitle")}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-5">
        {LOCALES.map((l) => {
          const active = locale === l.id;
          return (
            <button
              key={l.id}
              onClick={() => setLocale(l.id as Locale)}
              className={`h-14 rounded-xl border flex items-center gap-3 px-4 transition text-left ${active ? "border-toucan-400 bg-toucan-400/10 text-toucan-400" : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/50"}`}
            >
              <span className="text-xl">{l.flag}</span>
              <span className="text-sm font-medium flex-1">{l.label}</span>
              {active && <Check size={15} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepCertificate({ busy, onInstall }: { busy: boolean; onInstall: () => void }) {
  const installed = useFlows((s) => s.status.caInstalled);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-toucan-400/15 text-toucan-400 grid place-items-center"><ShieldCheck size={20} /></div>
        <div><h2 className="text-lg font-semibold">{t("ob.certTitle")}</h2></div>
      </div>
      <p className="text-sm opacity-70 leading-relaxed mt-3 mb-5">{t("ob.certSubtitle")}</p>
      <div className="rounded-xl border border-ink-100 dark:border-ink-400/30 p-5 bg-ink-50/60 dark:bg-ink-500/30">
        {installed ? (
          <div className="flex items-center gap-3 text-emerald-500">
            <div className="w-9 h-9 rounded-full bg-emerald-500/15 grid place-items-center"><Check size={18} /></div>
            <div className="text-sm font-medium">{t("ob.certInstalled")}</div>
          </div>
        ) : (
          <>
            <button onClick={onInstall} disabled={busy} className="w-full h-11 rounded-xl bg-toucan-400 text-white font-medium text-sm hover:bg-toucan-300 disabled:opacity-50 flex items-center justify-center gap-2 transition">
              <ShieldCheck size={15} /> {t("ob.certInstall")}
            </button>
            <div className="text-center text-[11px] opacity-50 mt-3">{t("ob.certSkip")}</div>
          </>
        )}
      </div>
    </div>
  );
}

function StepTips() {
  const port = useFlows((s) => s.status.port);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-500 grid place-items-center"><Check size={20} /></div>
        <div>
          <h2 className="text-lg font-semibold">{t("ob.tipsTitle")}</h2>
          <p className="text-xs opacity-60">{t("ob.tipsSubtitle")}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 mt-5">
        <Tip n={1} text={t("ob.tip1")} />
        <Tip n={2} text={t("ob.tip2", { port })} />
        <Tip n={3} text={t("ob.tip3")} />
      </div>
    </div>
  );
}

function Tip({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-ink-50 dark:bg-ink-500/40">
      <div className="w-6 h-6 rounded-full bg-toucan-400/20 text-toucan-400 grid place-items-center text-xs font-semibold mono shrink-0">{n}</div>
      <span className="text-sm leading-relaxed">{text}</span>
    </div>
  );
}
