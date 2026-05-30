import { useState } from "react";
import { ShieldCheck, Globe, Check, ArrowRight, ArrowLeft, Zap, Lock, Filter } from "lucide-react";
import { useFlows } from "@/stores/flows";
import { ipc } from "@/lib/ipc";
import { t, LOCALES, useLocale, setLocale, type Locale } from "@/lib/i18n";
import { Display, Accent } from "./Display";
import proxyMark from "@/assets/tucano-proxy-mark.svg";

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
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 backdrop-blur-md">
      <div className="relative w-[600px] max-w-[94vw] rounded-3xl bg-white dark:bg-[#050506] text-ink-500 dark:text-ink-50 border border-ink-100 dark:border-white/10 shadow-2xl overflow-hidden">
        {/* Ambient brand texture */}
        <div className="absolute inset-0 tcn-grid opacity-50 pointer-events-none" />
        <div className="absolute inset-x-0 top-0 h-48 tcn-glow-radial pointer-events-none" />

        {/* Progress bar */}
        <div className="relative h-1 bg-ink-100 dark:bg-white/[0.06]">
          <div className="absolute inset-y-0 left-0 tcn-accent transition-all duration-500 ease-out" style={{ width: `${((step + 1) / TOTAL) * 100}%` }} />
        </div>

        <div className="relative px-10 pt-9 pb-7 min-h-[392px]">
          {step === 0 && <StepWelcome />}
          {step === 1 && <StepLanguage />}
          {step === 2 && <StepCertificate busy={busy} onInstall={installCert} />}
          {step === 3 && <StepTips />}
        </div>

        {/* Footer */}
        <div className="relative px-7 py-4 border-t border-ink-100 dark:border-white/[0.07] flex items-center justify-between bg-ink-50/40 dark:bg-white/[0.015]">
          <div className="flex items-center gap-2">
            {Array.from({ length: TOTAL }).map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-6 tcn-accent" : i < step ? "w-1.5 bg-toucan-400/60" : "w-1.5 bg-ink-200 dark:bg-white/15"}`} />
            ))}
            <span className="ml-2 text-[11px] mono opacity-45">{t("ob.step", { n: step + 1, total: TOTAL })}</span>
          </div>

          <div className="flex items-center gap-2">
            {step === 0 && <button onClick={finish} className="h-9 px-3 text-xs opacity-55 hover:opacity-100 transition">{t("ob.skip")}</button>}
            {step > 0 && <button onClick={back} className="h-9 px-3 text-xs flex items-center gap-1.5 opacity-70 hover:opacity-100 transition"><ArrowLeft size={13} /> {t("ob.back")}</button>}
            <button
              onClick={step < TOTAL - 1 ? next : finish}
              className="h-9 px-4 text-xs rounded-xl tcn-accent tcn-accent-glow font-semibold flex items-center gap-1.5 transition hover:brightness-110"
            >
              {step < TOTAL - 1 ? t("ob.next") : t("ob.finish")} <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepWelcome() {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Glowing mark */}
      <div className="relative grid place-items-center mb-6">
        <span className="absolute w-28 h-28 rounded-full bg-toucan-400/20 blur-2xl" />
        <div className="relative w-[72px] h-[72px] grid place-items-center rounded-[22px] tcn-sheen ring-1 ring-inset ring-toucan-400/25 shadow-[0_10px_40px_-10px_rgba(106,87,224,0.6)]">
          <img src={proxyMark} alt="" className="w-10 h-10 object-contain" />
        </div>
      </div>

      <Display className="text-3xl mb-2">{t("ob.welcomeTitle")}</Display>
      <p className="text-sm opacity-65 max-w-md leading-relaxed mb-7">{t("ob.welcomeSubtitle")}</p>

      <div className="w-full flex flex-col gap-2 max-w-sm text-left">
        <Feature icon={<Zap size={15} />} text={t("ob.welcomeFeat1")} />
        <Feature icon={<Lock size={15} />} text={t("ob.welcomeFeat2")} />
        <Feature icon={<Filter size={15} />} text={t("ob.welcomeFeat3")} />
      </div>
    </div>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-2xl bg-white/60 dark:bg-white/[0.03] ring-1 ring-inset ring-ink-100/80 dark:ring-white/[0.06] tcn-sheen">
      <div className="w-8 h-8 rounded-xl tcn-accent-soft ring-1 ring-inset ring-toucan-400/25 text-toucan-500 dark:text-toucan-300 grid place-items-center shrink-0">{icon}</div>
      <span className="text-sm">{text}</span>
    </div>
  );
}

function StepHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <div className="w-11 h-11 rounded-2xl tcn-accent-soft ring-1 ring-inset ring-toucan-400/25 text-toucan-500 dark:text-toucan-300 grid place-items-center shrink-0">{icon}</div>
      <div>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs opacity-60">{subtitle}</p>}
      </div>
    </div>
  );
}

function StepLanguage() {
  const locale = useLocale((s) => s.locale);
  return (
    <div className="flex flex-col">
      <StepHeader icon={<Globe size={20} />} title={t("ob.langTitle")} subtitle={t("ob.langSubtitle")} />
      <div className="grid grid-cols-2 gap-2.5">
        {LOCALES.map((l) => {
          const active = locale === l.id;
          return (
            <button
              key={l.id}
              onClick={() => setLocale(l.id as Locale)}
              className={`group relative h-14 rounded-2xl ring-1 ring-inset flex items-center gap-3 px-4 transition text-left overflow-hidden ${active ? "tcn-accent-soft ring-toucan-400/40 text-toucan-500 dark:text-toucan-300" : "ring-ink-200/70 dark:ring-white/10 hover:ring-toucan-400/40 hover:bg-ink-50/60 dark:hover:bg-white/[0.03]"}`}
            >
              <span className="text-xl">{l.flag}</span>
              <span className="text-sm font-medium flex-1">{l.label}</span>
              {active && <Check size={16} className="text-toucan-400" />}
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
      <StepHeader icon={<ShieldCheck size={20} />} title={t("ob.certTitle")} />
      <p className="text-sm opacity-65 leading-relaxed mb-5">{t("ob.certSubtitle")}</p>
      <div className="rounded-2xl ring-1 ring-inset ring-ink-100 dark:ring-white/[0.07] p-5 bg-white/50 dark:bg-white/[0.02] tcn-sheen">
        {installed ? (
          <div className="flex items-center gap-3 text-emerald-500">
            <div className="w-10 h-10 rounded-full bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/30 grid place-items-center"><Check size={18} /></div>
            <div className="text-sm font-medium">{t("ob.certInstalled")}</div>
          </div>
        ) : (
          <>
            <button onClick={onInstall} disabled={busy} className="w-full h-11 rounded-xl tcn-accent tcn-accent-glow font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2 transition hover:brightness-110">
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
      <StepHeader icon={<Check size={20} />} title={t("ob.tipsTitle")} subtitle={t("ob.tipsSubtitle")} />
      <div className="flex flex-col gap-2.5">
        <Tip n={1} text={t("ob.tip1")} />
        <Tip n={2} text={t("ob.tip2", { port })} />
        <Tip n={3} text={t("ob.tip3")} />
      </div>
    </div>
  );
}

function Tip({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-white/55 dark:bg-white/[0.025] ring-1 ring-inset ring-ink-100/80 dark:ring-white/[0.06]">
      <div className="w-6 h-6 rounded-full tcn-accent grid place-items-center text-xs font-bold mono shrink-0 shadow-[0_4px_12px_-4px_rgba(106,87,224,0.7)]">{n}</div>
      <span className="text-sm leading-relaxed">{text}</span>
    </div>
  );
}
