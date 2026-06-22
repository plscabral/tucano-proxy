import { useEffect, useRef, useState } from "react";
import {
  X, ShieldCheck, Globe, Download, Keyboard, Network, Info, Sun, Moon, Monitor,
  ChevronDown, Lock, RefreshCw, FileText, Film, Music, Database, Plug, FileType,
  Braces, Type, FileCode2, Bot, Copy, RotateCw, Palette, Shapes, Check, Save,
} from "lucide-react";
import { SiJavascript, SiCss, SiHtml5, SiGraphql } from "react-icons/si";
import {
  FaFileImage, FaCode, FaFileImport, FaPencil, FaPenToSquare, FaTrash, FaEye, FaGear, FaWrench,
} from "react-icons/fa6";
import { getVersion } from "@tauri-apps/api/app";
import { useFlows } from "@/stores/flows";
import { useUpdater } from "@/stores/updater";
import { usePrefs } from "@/stores/prefs";
import { ipc, type McpClient, type McpClientStatus } from "@/lib/ipc";
import { t, LOCALES, useLocale, setLocale, type Locale } from "@/lib/i18n";
import { useTheme, setTheme, type ThemeMode } from "@/stores/theme";
import proxyMark from "@/assets/tucano-proxy-mark.svg";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

const SHORTCUTS: [string, string][] = [
  [`${MOD} + K`, "sk.focusFilter"],
  [`${MOD} + ⇧ + K`, "sk.removeLastFilter"],
  [`${MOD} + F`, "sk.bodySearch"],
  [`${MOD} + ⇧ + F`, "sk.findAll"],
  [`${MOD} + D`, "sk.compare"],
  [`${MOD} + L`, "sk.clearAll"],
  [`${MOD} + S`, "sk.saveSession"],
  [`${MOD} + O`, "sk.openSession"],
  [`${MOD} + ,`, "sk.openSettings"],
  [`${MOD} + A`, "sk.selectAll"],
  ["Space", "sk.toggleProxy"],
  ["1 – 9", "sk.switchCat"],
  [`${MOD} + 0–6`, "sk.markColor"],
  ["Right click", "sk.context"],
  ["Delete", "sk.delete"],
  ["M", "sk.note"],
];

async function refresh() { useFlows.getState().setStatus(await ipc.status()); }

type SslMode = "all" | "allowlist" | "blocklist";
type Tab = "general" | "proxy" | "localhost" | "cert" | "mcp" | "about" | "shortcuts" | "icons";

export default function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useFlows((s) => s.status);
  const autoCapture = usePrefs((s) => s.autoCapture);
  const locale = useLocale((s) => s.locale);

  const [port, setPort] = useState(status.port);
  const [busy, setBusy] = useState(false);
  const [sslMode, setSslMode] = useState<SslMode>("allowlist");
  const [sslHosts, setSslHosts] = useState("");
  const [skipHosts, setSkipHosts] = useState("");
  const [sslSaved, setSslSaved] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpPort, setMcpPort] = useState(7878);
  const [mcpToken, setMcpToken] = useState("");
  const [mcpSaved, setMcpSaved] = useState(false);
  const [mcpTransport, setMcpTransport] = useState<"http" | "stdio">("http");
  const [mcpBinPath, setMcpBinPath] = useState("");
  const [mcpCopied, setMcpCopied] = useState<"" | "token" | "config">("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const [mcpClients, setMcpClients] = useState<McpClientStatus[]>([]);
  const [mcpClientBusy, setMcpClientBusy] = useState<McpClient | "">("");
  // Snapshot of the last persisted MCP settings; `null` until the initial load
  // finishes. The autosave effect compares against it so it never writes on
  // open or re-persists unchanged values.
  const mcpSnap = useRef<string | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    (async () => {
      try {
        const s = await ipc.getSslSettings();
        setSslMode((s.mode as SslMode) || "allowlist");
        setSslHosts((s.hosts || []).join("\n"));
        setSkipHosts((s.skipHosts || []).join("\n"));
      } catch {}
      try { setAppVersion(await getVersion()); } catch {}
      try {
        const m = await ipc.getMcpSettings();
        setMcpEnabled(m.enabled); setMcpPort(m.port); setMcpToken(m.token);
        mcpSnap.current = JSON.stringify({ enabled: m.enabled, port: m.port, token: m.token });
      } catch {}
      try { setMcpClients(await ipc.listMcpClients()); } catch {}
      try { setMcpBinPath(await ipc.mcpBinaryPath()); } catch {}
    })();
  }, []);

  // Persist MCP settings automatically whenever they change — no Save button.
  // Debounced so typing in the port field doesn't write on every keystroke;
  // skipped on the initial load and when nothing actually changed.
  useEffect(() => {
    if (mcpSnap.current === null) return;
    const snap = JSON.stringify({ enabled: mcpEnabled, port: mcpPort, token: mcpToken });
    if (snap === mcpSnap.current) return;
    const id = setTimeout(() => { mcpSnap.current = snap; saveMcp(); }, 400);
    return () => clearTimeout(id);
  }, [mcpEnabled, mcpPort, mcpToken]);

  const refreshMcpClients = async () => { try { setMcpClients(await ipc.listMcpClients()); } catch {} };
  const installMcpClient = async (c: McpClient) => {
    if (!mcpToken) { alert(t("set.mcp.needToken")); return; }
    setMcpClientBusy(c);
    try { setMcpClients(await ipc.installMcpClient(c)); } catch (e) { alert(String(e)); } finally { setMcpClientBusy(""); }
  };
  const uninstallMcpClient = async (c: McpClient) => {
    setMcpClientBusy(c);
    try { setMcpClients(await ipc.uninstallMcpClient(c)); } catch (e) { alert(String(e)); } finally { setMcpClientBusy(""); }
  };
  const saveMcp = async () => {
    await ipc.setMcpSettings({ enabled: mcpEnabled, port: mcpPort, token: mcpToken });
    window.dispatchEvent(new Event("tucano:mcp-changed")); // refresh StatusBar MCP indicator
    setMcpSaved(true); setTimeout(() => setMcpSaved(false), 1500);
  };
  const rotateMcpToken = async () => {
    if (!confirm(t("set.mcp.rotateConfirm"))) return;
    const m = await ipc.rotateMcpToken();
    setMcpToken(m.token);
  };
  const mcpConfigSnippet = (real = false) => {
    const tok = real || tokenVisible ? mcpToken : "•".repeat(mcpToken.length);
    const url = `http://127.0.0.1:${mcpPort}/mcp`;
    const entry = mcpTransport === "stdio"
      ? {
          command: mcpBinPath || "/path/to/tucano-proxy",
          args: ["mcp-stdio"],
          env: { TUCANO_MCP_URL: url, TUCANO_MCP_TOKEN: tok },
        }
      : {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${tok}` },
        };
    return JSON.stringify({ mcpServers: { tucano: entry } }, null, 2);
  };
  const copyMcp = async (kind: "token" | "config") => {
    const text = kind === "token" ? mcpToken : mcpConfigSnippet(true);
    await navigator.clipboard.writeText(text);
    setMcpCopied(kind); setTimeout(() => setMcpCopied(""), 1500);
  };

  const saveSsl = async () => {
    const hosts = sslHosts.split("\n").map((s) => s.trim()).filter(Boolean);
    const skipHostsList = skipHosts.split("\n").map((s) => s.trim()).filter(Boolean);
    await ipc.setSslSettings({ mode: sslMode, hosts, skipHosts: skipHostsList });
    setSslSaved(true); setTimeout(() => setSslSaved(false), 1500);
  };

  const installCa = async () => {
    setBusy(true);
    try { await ipc.installCa(); await refresh(); } catch (e) { console.error(e); alert(String(e)); } finally { setBusy(false); }
  };
  const uninstallCa = async () => {
    if (!confirm(t("set.uninstallCaConfirm"))) return;
    setBusy(true);
    try { await ipc.uninstallCa(); await refresh(); } catch (e) { console.error(e); alert(String(e)); } finally { setBusy(false); }
  };
  const exportCa = async () => {
    const pem = await ipc.exportCa();
    const blob = new Blob([pem], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "tucano-root.pem"; a.click();
    URL.revokeObjectURL(url);
  };

  // Grouped nav — related settings sit together under a small section label so
  // the dialog reads as a few clear areas instead of one long flat list.
  const NAV_GROUPS: { label: string; items: { id: Tab; icon: React.ReactNode; label: string }[] }[] = [
    { label: t("set.group.general"), items: [
      { id: "general", icon: <Palette size={14} />, label: t("set.appearance") },
      { id: "shortcuts", icon: <Keyboard size={14} />, label: t("set.shortcuts") },
    ] },
    { label: t("set.group.capture"), items: [
      { id: "proxy", icon: <Network size={14} />, label: t("set.proxy") },
      { id: "localhost", icon: <Globe size={14} />, label: t("set.localhost") },
      { id: "cert", icon: <ShieldCheck size={14} />, label: t("set.cert") },
    ] },
    { label: t("set.group.integrations"), items: [
      { id: "mcp", icon: <Bot size={14} />, label: "MCP" },
    ] },
    { label: t("set.group.reference"), items: [
      { id: "icons", icon: <Shapes size={14} />, label: t("set.iconsTitle") },
      { id: "about", icon: <Info size={14} />, label: t("set.aboutTitle") },
    ] },
  ];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[880px] max-w-[92vw] h-[640px] max-h-[86vh] flex flex-col rounded-2xl bg-white dark:bg-[var(--tcn-canvas)] text-ink-500 dark:text-ink-50 border border-ink-100 dark:border-white/10 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative shrink-0 border-b border-ink-100 dark:border-white/10 overflow-hidden">
          <div className="absolute inset-0 tcn-grid opacity-50 pointer-events-none" />
          <div className="absolute inset-0 tcn-glow-radial pointer-events-none" />
          <div className="relative flex items-center justify-between px-5 h-16">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 grid place-items-center rounded-xl tcn-sheen ring-1 ring-inset ring-ink-200/50 dark:ring-white/10 shadow-soft">
                <img src={proxyMark} alt="" className="w-5 h-5 object-contain" />
              </div>
              <div className="leading-none">
                <div className="font-bold tracking-tight text-base">{t("set.title")}</div>
                <div className="text-[11px] opacity-50 mt-1.5">Tucano <span className="font-accent">Proxy</span></div>
              </div>
            </div>
            <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-lg opacity-70 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-white/10 transition"><X size={18} /></button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <nav className="w-52 shrink-0 border-r border-ink-100 dark:border-white/[0.07] py-3 px-2 flex flex-col gap-4 overflow-auto scroll-thin">
            {NAV_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <div className="px-3 mb-1 text-[10px] uppercase tracking-[0.12em] opacity-40 font-semibold">{g.label}</div>
                {g.items.map((tb) => (
                  <button
                    key={tb.id}
                    onClick={() => setTab(tb.id)}
                    className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-xl text-xs transition text-left ${tab === tb.id ? "tcn-accent-soft text-toucan-500 dark:text-toucan-300 ring-1 ring-inset ring-toucan-400/25 font-semibold shadow-[0_0_20px_-12px_rgba(106,87,224,0.8)]" : "opacity-75 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-white/[0.04]"}`}
                  ><span className={tab === tb.id ? "" : "opacity-80"}>{tb.icon}</span><span className="truncate">{tb.label}</span></button>
                ))}
              </div>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-auto scroll-thin">
            {tab === "general" && (
              <Section icon={<Sun size={14} />} title={t("set.appearance")}>
                <Row title={t("set.theme")}>
                  <div className="flex gap-1 p-1 rounded-xl bg-ink-50 dark:bg-white/[0.04] w-[320px]">
                    <ThemeOpt mode="light" icon={<Sun size={13} />} label={t("set.themeLight")} />
                    <ThemeOpt mode="dark" icon={<Moon size={13} />} label={t("set.themeDark")} />
                    <ThemeOpt mode="system" icon={<Monitor size={13} />} label={t("set.themeSystem")} />
                  </div>
                </Row>
                <Row title={t("set.language")}>
                  <div className="relative w-[320px]">
                    <select
                      value={locale}
                      onChange={(e) => setLocale(e.currentTarget.value as Locale)}
                      className="appearance-none w-full h-10 pl-3.5 pr-9 text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 focus:border-toucan-400 outline-none cursor-pointer"
                    >
                      {LOCALES.map((l) => <option key={l.id} value={l.id}>{l.flag}  {l.label}</option>)}
                    </select>
                    <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
                  </div>
                </Row>
              </Section>
            )}

            {tab === "proxy" && (
              <Section icon={<Network size={14} />} title={t("set.proxy")}>
                <div className="flex items-center gap-3">
                  <label className="text-xs opacity-70 w-14">{t("set.port")}</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.currentTarget.value) || 8888)}
                    className="w-28 h-9 px-3 mono text-sm rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
                  />
                  <span className={`mono text-xs ${status.running ? "text-toucan-400" : "opacity-50"}`}>
                    ● {status.running ? t("set.running", { port: status.port }) : t("set.stopped")}
                  </span>
                </div>
                <Row icon={<Globe size={14} />} title={t("set.autoCapture")} hint={t("set.autoCaptureHint")}>
                  <Toggle checked={autoCapture} onChange={(v) => usePrefs.getState().setAutoCapture(v)} label={t("set.autoCapture")} />
                </Row>
              </Section>
            )}

            {tab === "localhost" && (
              <Section icon={<Globe size={14} />} title={t("set.localhost")}>
                <p className="text-xs opacity-70 leading-relaxed">{t("set.localhostHint")}</p>
                <LocalhostBlock port={status.port} />
              </Section>
            )}

            {tab === "cert" && (
              <>
                <Section icon={<ShieldCheck size={14} />} title={t("set.cert")}>
                  <p className="text-xs opacity-70 leading-relaxed">{t("set.certHint")}</p>
                  <div className="flex items-center gap-2">
                    <button onClick={installCa} disabled={busy}
                      className={`h-9 px-4 text-xs rounded-xl flex items-center gap-1.5 border transition ${status.caInstalled ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-500" : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}>
                      <ShieldCheck size={13} /> {status.caInstalled ? t("set.caTrustedBtn") : t("set.installCa")}
                    </button>
                    {status.caInstalled && (
                      <button onClick={uninstallCa} disabled={busy} className="h-9 px-4 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 flex items-center gap-1.5">
                        {t("set.uninstallCa")}
                      </button>
                    )}
                    <button onClick={exportCa} className="h-9 px-4 text-xs rounded-xl border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 flex items-center gap-1.5">
                      <Download size={13} /> {t("set.exportCa")}
                    </button>
                  </div>
                </Section>

                <Section icon={<Lock size={14} />} title={t("set.ssl")}>
                  <p className="text-xs opacity-70 leading-relaxed">
                    {t("set.sslIntro")}
                  </p>
                  <div className="flex gap-1 p-1 rounded-xl bg-ink-50 dark:bg-white/[0.04] w-full">
                    <SslOpt mode="allowlist" label={t("set.sslTab.allow")} current={sslMode} setCurrent={setSslMode} />
                    <SslOpt mode="all" label={t("set.sslTab.all")} current={sslMode} setCurrent={setSslMode} />
                    <SslOpt mode="blocklist" label={t("set.sslTab.block")} current={sslMode} setCurrent={setSslMode} />
                  </div>
                  {sslMode !== "all" && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">
                        {sslMode === "allowlist" ? t("set.sslInclude") : t("set.sslExclude")}
                      </div>
                      <textarea
                        value={sslHosts}
                        onChange={(e) => setSslHosts(e.currentTarget.value)}
                        placeholder={"api.example.com\n*.foo.com"}
                        className="w-full h-28 px-3 py-2 mono text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
                      />
                    </div>
                  )}
                  {sslMode === "all" && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">{t("set.sslBypass")}</div>
                      <textarea
                        value={skipHosts}
                        onChange={(e) => setSkipHosts(e.currentTarget.value)}
                        placeholder={"*.example.com\napi.pinned-app.com"}
                        className="w-full h-24 px-3 py-2 mono text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
                      />
                      <div className="text-[10px] opacity-50 mt-1">{t("set.sslWildcard")}</div>
                    </div>
                  )}
                  <button onClick={saveSsl} className={`self-start h-9 px-5 text-xs rounded-xl font-medium transition ${sslSaved ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40" : "tcn-accent tcn-accent-glow"}`}>
                    {sslSaved ? t("set.sslSaved") : t("set.sslSave")}
                  </button>
                </Section>

                <Section icon={<Info size={14} />} title={t("set.whyTitle")}>
                  <ul className="text-xs opacity-80 flex flex-col gap-1.5 list-disc pl-5 leading-relaxed">
                    <li>{t("set.why1")}</li>
                    <li>{t("set.why2")}</li>
                    <li>{t("set.why3")}</li>
                    <li>{t("set.why4")}</li>
                  </ul>
                </Section>
              </>
            )}

            {tab === "mcp" && (
              <>
                <Section icon={<Bot size={14} />} title={t("set.mcp.bridge")}>
                  <p className="text-xs opacity-70 leading-relaxed">
                    {t("set.mcp.bridgeHint")}
                  </p>
                  <Row title={t("set.mcp.enable")} hint={t("set.mcp.enableHint")}>
                    <Toggle checked={mcpEnabled} onChange={setMcpEnabled} label={t("set.mcp.enable")} />
                  </Row>
                  <div className="flex items-center gap-3">
                    <label className="text-xs opacity-70 w-14">{t("set.mcp.port")}</label>
                    <input type="number" value={mcpPort} onChange={(e) => setMcpPort(Number(e.currentTarget.value) || 7878)} className="w-28 h-9 px-3 mono text-sm rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none" />
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">{t("set.mcp.token")}</div>
                    <div className="flex items-center gap-2">
                      <input type={tokenVisible ? "text" : "password"} readOnly value={mcpToken} className="flex-1 h-9 px-3 mono text-xs rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40 outline-none" />
                      <button onClick={() => setTokenVisible(!tokenVisible)} className="h-9 px-3 text-xs rounded-xl border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60">{tokenVisible ? t("set.mcp.hide") : t("set.mcp.show")}</button>
                      <button onClick={() => copyMcp("token")} className={`h-9 px-3 text-xs rounded-xl border flex items-center gap-1.5 transition ${mcpCopied === "token" ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-500" : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}><Copy size={13} /> {mcpCopied === "token" ? t("set.copied") : t("set.copy")}</button>
                      <button onClick={rotateMcpToken} className="h-9 px-3 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 flex items-center gap-1.5"><RotateCw size={13} /> {t("set.mcp.rotate")}</button>
                    </div>
                  </div>
                  <div className="self-start flex items-center gap-1.5 h-7 text-[11px] opacity-60">
                    {mcpSaved ? <Check size={13} className="text-emerald-500" /> : <Save size={12} />}
                    <span className={mcpSaved ? "text-emerald-500 opacity-100" : ""}>{mcpSaved ? t("set.mcp.saved") : t("set.mcp.autosave")}</span>
                  </div>
                </Section>

                <Section icon={<Plug size={14} />} title={t("set.mcp.installTitle")}>
                  <p className="text-xs opacity-70 leading-relaxed">
                    {t("set.mcp.installHint")}
                  </p>
                  <div className="flex flex-col gap-2">
                    {mcpClients.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl border border-ink-100 dark:border-ink-400/40">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium flex items-center gap-2">
                            {c.label}
                            {c.installed && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-500 border border-emerald-500/40">{t("set.mcp.installed")}</span>}
                          </div>
                          <div className="text-[11px] mono opacity-60 truncate">{c.path}</div>
                        </div>
                        {c.installed ? (
                          <button disabled={mcpClientBusy === c.id} onClick={() => uninstallMcpClient(c.id)} className="h-8 px-3 text-xs rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50">{t("set.mcp.remove")}</button>
                        ) : (
                          <button disabled={mcpClientBusy === c.id} onClick={() => installMcpClient(c.id)} className="h-8 px-3 text-xs rounded-lg tcn-accent tcn-accent-glow disabled:opacity-50">{t("set.mcp.install")}</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button onClick={refreshMcpClients} className="h-8 px-3 text-xs rounded-lg border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 flex items-center gap-1.5"><RefreshCw size={12} /> {t("set.mcp.refresh")}</button>
                </Section>

                <Section icon={<Info size={14} />} title={t("set.mcp.configTitle")}>
                  <p className="text-xs opacity-70 leading-relaxed">
                    {t("set.mcp.configHint")}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex p-0.5 rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40">
                      {(["http", "stdio"] as const).map((tr) => (
                        <button
                          key={tr}
                          onClick={() => setMcpTransport(tr)}
                          className={`h-7 px-3 text-xs rounded-lg font-medium transition ${mcpTransport === tr ? "tcn-accent" : "opacity-60 hover:opacity-100"}`}
                        >
                          {tr === "http" ? t("set.mcp.transportHttp") : t("set.mcp.transportStdio")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] opacity-60 leading-relaxed">
                    {mcpTransport === "stdio" ? t("set.mcp.transportStdioHint") : t("set.mcp.transportHttpHint")}
                  </p>
                  <div className="relative">
                    <pre className="text-[11px] mono p-3 rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40 overflow-auto whitespace-pre">{mcpConfigSnippet()}</pre>
                    <button onClick={() => copyMcp("config")} className={`absolute top-2 right-2 h-7 px-2 text-[11px] rounded-lg border flex items-center gap-1.5 transition ${mcpCopied === "config" ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-500" : "bg-white dark:bg-[var(--tcn-canvas)] border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}><Copy size={11} /> {mcpCopied === "config" ? t("set.copied") : t("set.copy")}</button>
                  </div>
                </Section>
              </>
            )}

            {tab === "icons" && (
              <Section icon={<Info size={14} />} title={t("set.iconsTitle")}>
                <p className="text-xs opacity-70 leading-relaxed">{t("set.iconsHint")}</p>
                <div className="flex flex-col gap-4 text-xs">
                  <IconGroup title={t("set.iconsMethod")}>
                    <IconRow icon={<FaCode color="#34D399" size={14} />} label="GET" hint={t("set.icon.get")} />
                    <IconRow icon={<FaFileImport color="#67E8F9" size={14} />} label="POST" hint={t("set.icon.post")} />
                    <IconRow icon={<FaPenToSquare color="#FBBF24" size={14} />} label="PUT" hint={t("set.icon.put")} />
                    <IconRow icon={<FaPencil color="#E879F9" size={14} />} label="PATCH" hint={t("set.icon.patch")} />
                    <IconRow icon={<FaTrash color="#F87171" size={14} />} label="DELETE" hint={t("set.icon.delete")} />
                    <IconRow icon={<FaEye color="#A78BFA" size={14} />} label="HEAD" hint={t("set.icon.head")} />
                    <IconRow icon={<FaGear color="#2DD4BF" size={14} />} label="OPTIONS" hint={t("set.icon.options")} />
                    <IconRow icon={<FaWrench color="#CBD5E1" size={14} />} label={t("set.icon.otherMethod")} hint={t("set.icon.otherMethodHint")} />
                  </IconGroup>
                  <IconGroup title={t("set.iconsType")}>
                    <IconRow icon={<SiHtml5 color="#E34F26" size={14} />} label="HTML" hint={t("set.icon.html")} />
                    <IconRow icon={<SiCss color="#1572B6" size={14} />} label="CSS" hint={t("set.icon.css")} />
                    <IconRow icon={<SiJavascript color="#F7DF1E" size={14} />} label="JavaScript" hint={t("set.icon.js")} />
                    <IconRow icon={<Braces size={14} className="text-amber-300" />} label="JSON" hint={t("set.icon.json")} />
                    <IconRow icon={<FileCode2 size={14} className="text-orange-400" />} label="XML" hint={t("set.icon.xml")} />
                    <IconRow icon={<SiGraphql color="#E10098" size={14} />} label="GraphQL" hint={t("set.icon.graphql")} />
                    <IconRow icon={<FileType size={14} className="text-red-300" />} label="PDF" hint={t("set.icon.pdf")} />
                    <IconRow icon={<FileText size={14} className="text-teal-300" />} label="Form" hint={t("set.icon.form")} />
                    <IconRow icon={<FaFileImage color="#A78BFA" size={14} />} label={t("set.icon.image")} hint={t("set.icon.imageHint")} />
                    <IconRow icon={<Film size={14} className="text-violet-300" />} label="Video" hint={t("set.icon.video")} />
                    <IconRow icon={<Music size={14} className="text-violet-300" />} label="Audio" hint={t("set.icon.audio")} />
                    <IconRow icon={<Type size={14} className="text-cyan-300" />} label={t("set.icon.font")} hint={t("set.icon.fontHint")} />
                    <IconRow icon={<Database size={14} className="text-slate-300" />} label="Binary" hint={t("set.icon.binary")} />
                    <IconRow icon={<FileText size={14} className="text-slate-200" />} label="Text" hint={t("set.icon.text")} />
                  </IconGroup>
                  <IconGroup title={t("set.iconsSpecial")}>
                    <IconRow icon={<Plug size={14} className="text-fuchsia-300" />} label="WebSocket" hint={t("set.icon.ws")} />
                    <IconRow icon={<Network size={14} className="text-slate-300" />} label="CONNECT" hint={t("set.icon.connect")} />
                  </IconGroup>
                  <IconGroup title={t("set.iconsStatus")}>
                    <IconRow icon={<span className="h-3 w-3 rounded-full bg-slate-300 inline-block" />} label="2xx / —" hint={t("set.icon.s2xx")} />
                    <IconRow icon={<span className="h-3 w-3 rounded-full bg-cyan-300 inline-block" />} label="3xx" hint={t("set.icon.s3xx")} />
                    <IconRow icon={<span className="h-3 w-3 rounded-full bg-slate-400 inline-block" />} label="304" hint={t("set.icon.s304")} />
                    <IconRow icon={<span className="h-3 w-3 rounded-full bg-amber-300 inline-block" />} label="4xx" hint={t("set.icon.s4xx")} />
                    <IconRow icon={<span className="h-3 w-3 rounded-full bg-red-300 inline-block" />} label="5xx" hint={t("set.icon.s5xx")} />
                  </IconGroup>
                </div>
              </Section>
            )}

            {tab === "about" && <AboutSection appVersion={appVersion} />}

            {tab === "shortcuts" && (
              <Section icon={<Keyboard size={14} />} title={t("set.shortcuts")}>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                  {SHORTCUTS.map(([k, v]) => (
                    <div key={v} className="flex items-center justify-between gap-3">
                      <span className="opacity-70">{t(v)}</span>
                      <kbd className="mono text-[11px] px-1.5 py-0.5 rounded bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40">{k}</kbd>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutSection({ appVersion }: { appVersion: string }) {
  const state = useUpdater((u) => u.state);
  const version = useUpdater((u) => u.version);
  const progress = useUpdater((u) => u.progress);
  const error = useUpdater((u) => u.error);
  const notes = useUpdater((u) => u.notes);
  const up = useUpdater.getState();
  return (
    <Section icon={<RefreshCw size={14} />} title={t("set.aboutTitle")}>
      <div className="text-xs flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="opacity-70">{t("set.currentVersion")}</span>
          <span className="mono">{appVersion || "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="opacity-70">{t("set.updateStatus")}</span>
          <span className="mono opacity-80">
            {state === "idle" && t("updater.idle")}
            {state === "checking" && t("updater.checking")}
            {state === "available" && `${t("updater.available")} v${version}`}
            {state === "downloading" && `${t("updater.downloading")} ${Math.round(progress * 100)}%`}
            {state === "ready" && `${t("updater.ready")} v${version}`}
            {state === "upToDate" && t("updater.upToDate")}
            {state === "error" && t("updater.error")}
          </span>
        </div>
        {state === "error" && error && <div className="text-[11px] opacity-60 mono break-all">{error}</div>}
        <div className="flex gap-2 pt-1">
          {state === "available" ? (
            <button onClick={() => up.download()} className="h-8 px-3 rounded-lg text-xs tcn-accent tcn-accent-glow">{t("set.downloadUpdate")}</button>
          ) : state === "ready" ? (
            <button onClick={() => up.restart()} className="h-8 px-3 rounded-lg text-xs tcn-accent tcn-accent-glow">{t("updater.restart")}</button>
          ) : (
            <button onClick={() => up.check()} disabled={state === "checking" || state === "downloading"} className="h-8 px-3 rounded-lg text-xs bg-ink-50 dark:bg-white/[0.04] hover:bg-ink-100 dark:hover:bg-ink-400/40 disabled:opacity-50">{t("set.checkUpdates")}</button>
          )}
        </div>
        {notes && <pre className="text-[11px] opacity-70 whitespace-pre-wrap font-sans pt-1 leading-relaxed">{notes}</pre>}
      </div>
    </Section>
  );
}

function IconGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider opacity-60 mono mb-1.5">{title}</div>
      <div className="rounded-xl border border-ink-100 dark:border-ink-400/30 divide-y divide-ink-100 dark:divide-ink-400/20">{children}</div>
    </div>
  );
}

function IconRow({ icon, label, hint }: { icon: React.ReactNode; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="w-5 grid place-items-center shrink-0">{icon}</div>
      <div className="font-medium mono text-[11px] w-24 shrink-0">{label}</div>
      <div className="opacity-70 leading-relaxed">{hint}</div>
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

function SslOpt({ mode, label, current, setCurrent }: { mode: SslMode; label: string; current: SslMode; setCurrent: (m: SslMode) => void }) {
  const active = current === mode;
  return (
    <button onClick={() => setCurrent(mode)} className={`flex-1 h-8 rounded-lg flex items-center justify-center text-xs transition truncate px-2 ${active ? "bg-white dark:bg-[var(--tcn-canvas)] text-toucan-400 shadow-sm font-medium" : "opacity-70 hover:opacity-100"}`}>{label}</button>
  );
}

function ThemeOpt({ mode, icon, label }: { mode: ThemeMode; icon: React.ReactNode; label: string }) {
  const active = useTheme((s) => s.mode) === mode;
  return (
    <button onClick={() => setTheme(mode)} className={`flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 text-xs transition ${active ? "bg-white dark:bg-[var(--tcn-canvas)] text-toucan-400 shadow-sm" : "opacity-70 hover:opacity-100"}`}>{icon} {label}</button>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-ink-100 dark:border-ink-400/20 last:border-0 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-toucan-400">{icon}<span className="text-xs uppercase tracking-wider font-semibold">{title}</span></div>
      {children}
    </div>
  );
}

function Row({ icon, title, hint, children }: { icon?: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      {icon && <div className="mt-1 opacity-70">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="text-sm">{title}</div>
        {hint && <div className="text-xs opacity-60 mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function CopyLine({ value, hint }: { value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch {}
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 truncate mono text-xs px-3 h-9 grid items-center rounded-xl bg-ink-50 dark:bg-white/[0.04] border border-ink-100 dark:border-ink-400/40">{value}</code>
      <button onClick={copy} title={hint} className="h-9 px-3 rounded-xl border text-xs flex items-center gap-1.5 border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 hover:text-toucan-400 transition">
        <Copy size={12} /> {copied ? t("set.copied") : t("set.copy")}
      </button>
    </div>
  );
}

function LocalhostBlock({ port }: { port: number }) {
  const alias = "tucano.local";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] uppercase tracking-wider opacity-60 mono font-medium">{t("set.localhost.aliasLabel")}</div>
        <CopyLine value={`http://${alias}:3000`} />
        <div className="text-[11px] opacity-60 leading-relaxed">{t("set.localhost.aliasHelp")}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] uppercase tracking-wider opacity-60 mono font-medium">{t("set.localhost.cliLabel")}</div>
        <CopyLine value={`export HTTPS_PROXY=http://127.0.0.1:${port} HTTP_PROXY=http://127.0.0.1:${port}`} />
        <div className="text-[11px] opacity-60 leading-relaxed">{t("set.localhost.cliHelp")}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] uppercase tracking-wider opacity-60 mono font-medium">{t("set.localhost.chromeLabel")}</div>
        <CopyLine value={`open -na "Google Chrome" --args --proxy-server=http://127.0.0.1:${port} --proxy-bypass-list='<-loopback>'`} />
        <div className="text-[11px] opacity-60 leading-relaxed">{t("set.localhost.chromeHelp")}</div>
      </div>
    </div>
  );
}
