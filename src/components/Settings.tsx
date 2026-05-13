import { createSignal, onMount, Show, For } from "solid-js";
import {
  X, ShieldCheck, Globe, Download, Keyboard, Network, Info, Sun, Moon, Monitor,
  ChevronDown, Lock, RefreshCw, FileText, Film, Music, Database, Plug, FileType,
  Braces, Type, FileCode2, Bot, Copy, RotateCw,
} from "lucide-solid";
import { SiJavascript, SiCss, SiHtml5, SiGraphql } from "solid-icons/si";
import {
  FaSolidFileImage, FaSolidCode, FaSolidFileImport, FaSolidPencil,
  FaSolidPenToSquare, FaSolidTrash, FaSolidEye, FaSolidGear, FaSolidWrench,
} from "solid-icons/fa";
import { getVersion } from "@tauri-apps/api/app";
import { flowsStore } from "../stores/flows";
import { updaterStore } from "../stores/updater";
import { prefsStore } from "../stores/prefs";
import { ipc, type McpClient, type McpClientStatus } from "../lib/ipc";
import { t, LOCALES, currentLocale, setLocale, type Locale } from "../lib/i18n";
import { themeMode, setTheme, type ThemeMode } from "../stores/theme";

// Show shortcuts using the modifier symbol native to the user's platform.
// macOS users see ⌘, Windows / Linux see Ctrl — no more "⌘ / Ctrl" double
// labels cluttering the list.
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

const SHORTCUTS: [string, string][] = [
  [`${MOD} + K`,    "sk.focusFilter"],
  [`${MOD} + ⇧ + K`,     "sk.removeLastFilter"],
  [`${MOD} + F`,         "sk.bodySearch"],
  [`${MOD} + ⇧ + F`,     "sk.findAll"],
  [`${MOD} + D`,    "sk.compare"],
  [`${MOD} + L`,    "sk.clearAll"],
  [`${MOD} + S`,    "sk.saveSession"],
  [`${MOD} + O`,    "sk.openSession"],
  [`${MOD} + ,`,    "sk.openSettings"],
  [`${MOD} + A`,    "sk.selectAll"],
  ["Space",         "sk.toggleProxy"],
  ["1 – 9",         "sk.switchCat"],
  [`${MOD} + 0–6`,  "sk.markColor"],
  ["Right click",   "sk.context"],
  ["Delete",        "sk.delete"],
  ["M",             "sk.note"],
];

async function refresh() { flowsStore.setStatus(await ipc.status()); }

type SslMode = "all" | "allowlist" | "blocklist";

export default function Settings(props: { open: boolean; onClose: () => void }) {
  const [port, setPort] = createSignal(flowsStore.status().port);
  const [busy, setBusy] = createSignal(false);
  const [sslMode, setSslMode] = createSignal<SslMode>("allowlist");
  const [sslHosts, setSslHosts] = createSignal("");
  const [skipHosts, setSkipHosts] = createSignal("");
  const [sslSaved, setSslSaved] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal("");
  const [mcpEnabled, setMcpEnabled] = createSignal(false);
  const [mcpPort, setMcpPort] = createSignal(7878);
  const [mcpToken, setMcpToken] = createSignal("");
  const [mcpSaved, setMcpSaved] = createSignal(false);
  const [mcpCopied, setMcpCopied] = createSignal<"" | "token" | "config">("");
  const [tokenVisible, setTokenVisible] = createSignal(false);
  const [mcpClients, setMcpClients] = createSignal<McpClientStatus[]>([]);
  const [mcpClientBusy, setMcpClientBusy] = createSignal<McpClient | "">("");

  onMount(async () => {
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
    } catch {}
    try { setMcpClients(await ipc.listMcpClients()); } catch {}
  });

  const refreshMcpClients = async () => {
    try { setMcpClients(await ipc.listMcpClients()); } catch {}
  };
  const installMcpClient = async (c: McpClient) => {
    if (!mcpToken()) { alert("Save the MCP settings first so a token exists."); return; }
    setMcpClientBusy(c);
    try { setMcpClients(await ipc.installMcpClient(c)); }
    catch (e) { alert(String(e)); }
    finally { setMcpClientBusy(""); }
  };
  const uninstallMcpClient = async (c: McpClient) => {
    setMcpClientBusy(c);
    try { setMcpClients(await ipc.uninstallMcpClient(c)); }
    catch (e) { alert(String(e)); }
    finally { setMcpClientBusy(""); }
  };

  const saveMcp = async () => {
    await ipc.setMcpSettings({ enabled: mcpEnabled(), port: mcpPort(), token: mcpToken() });
    setMcpSaved(true);
    setTimeout(() => setMcpSaved(false), 1500);
  };
  const rotateMcpToken = async () => {
    if (!confirm("Rotate MCP token? Existing clients will need to be reconfigured.")) return;
    const m = await ipc.rotateMcpToken();
    setMcpToken(m.token);
  };
  const copyMcp = async (kind: "token" | "config") => {
    // Copy always uses the real token — masking is just visual.
    const text = kind === "token" ? mcpToken() : mcpConfigSnippet(true);
    await navigator.clipboard.writeText(text);
    setMcpCopied(kind);
    setTimeout(() => setMcpCopied(""), 1500);
  };
  const mcpConfigSnippet = (real = false) => JSON.stringify({
    mcpServers: {
      tucano: {
        command: "npx",
        args: ["-y", "tucano-mcp"],
        env: {
          TUCANO_TOKEN: real || tokenVisible() ? mcpToken() : "•".repeat(mcpToken().length),
          ...(mcpPort() !== 7878 ? { TUCANO_URL: `http://127.0.0.1:${mcpPort()}` } : {}),
        },
      },
    },
  }, null, 2);

  const saveSsl = async () => {
    const hosts = sslHosts().split("\n").map((s) => s.trim()).filter(Boolean);
    const skipHostsList = skipHosts().split("\n").map((s) => s.trim()).filter(Boolean);
    await ipc.setSslSettings({ mode: sslMode(), hosts, skipHosts: skipHostsList });
    setSslSaved(true);
    setTimeout(() => setSslSaved(false), 1500);
  };

  const installCa = async () => {
    setBusy(true);
    try { await ipc.installCa(); await refresh(); } finally { setBusy(false); }
  };
  const uninstallCa = async () => {
    if (!confirm(t("set.uninstallCaConfirm"))) return;
    setBusy(true);
    try { await ipc.uninstallCa(); await refresh(); }
    catch (e) { console.error(e); alert(String(e)); }
    finally { setBusy(false); }
  };
  const exportCa = async () => {
    const pem = await ipc.exportCa();
    const blob = new Blob([pem], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "tucano-root.pem"; a.click();
    URL.revokeObjectURL(url);
  };
  type Tab = "general" | "proxy" | "cert" | "mcp" | "about" | "shortcuts" | "icons";
  const [tab, setTab] = createSignal<Tab>("general");
  const TABS: { id: Tab; icon: any; label: string }[] = [
    { id: "general",   icon: <Sun size={14} />,         label: t("set.appearance") },
    { id: "proxy",     icon: <Network size={14} />,     label: t("set.proxy") },
    { id: "cert",      icon: <ShieldCheck size={14} />, label: t("set.cert") },
    { id: "mcp",       icon: <Bot size={14} />,         label: "MCP (LLM tools)" },
    { id: "icons",     icon: <Info size={14} />,        label: t("set.iconsTitle") },
    { id: "about",     icon: <RefreshCw size={14} />,   label: t("set.aboutTitle") },
    { id: "shortcuts", icon: <Keyboard size={14} />,    label: t("set.shortcuts") },
  ];
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm" onClick={props.onClose}>
        <div
          class="w-[880px] max-w-[92vw] h-[640px] max-h-[86vh] flex flex-col rounded-2xl
                 bg-white dark:bg-ink-600 text-ink-500 dark:text-ink-50
                 border border-ink-100 dark:border-ink-400/40 shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between px-5 h-14 border-b border-ink-100 dark:border-ink-400/30 shrink-0">
            <div class="font-semibold text-base">{t("set.title")}</div>
            <button onClick={props.onClose} class="opacity-70 hover:opacity-100"><X size={18} /></button>
          </div>

          <div class="flex flex-1 min-h-0">
            <nav class="w-52 shrink-0 border-r border-ink-100 dark:border-ink-400/30 py-3 px-2 space-y-0.5 overflow-auto scroll-thin">
              <For each={TABS}>{(tb) => (
                <button
                  onClick={() => setTab(tb.id)}
                  class={`w-full flex items-center gap-2 px-3 h-9 rounded-xl text-xs transition text-left
                    ${tab() === tb.id
                      ? "bg-toucan-400/15 text-toucan-400 font-medium"
                      : "opacity-75 hover:opacity-100 hover:bg-ink-50 dark:hover:bg-ink-500"}`}
                >{tb.icon}<span class="truncate">{tb.label}</span></button>
              )}</For>
            </nav>
            <div class="flex-1 min-w-0 overflow-auto scroll-thin">

          <Show when={tab() === "general"}>
          <Section icon={<Sun size={14} />} title={t("set.appearance")}>
            <Row title={t("set.theme")}>
              <div class="flex gap-1 p-1 rounded-xl bg-ink-50 dark:bg-ink-500 w-[320px]">
                <ThemeOpt mode="light"  icon={<Sun size={13} />}     label={t("set.themeLight")} />
                <ThemeOpt mode="dark"   icon={<Moon size={13} />}    label={t("set.themeDark")} />
                <ThemeOpt mode="system" icon={<Monitor size={13} />} label={t("set.themeSystem")} />
              </div>
            </Row>
            <Row title={t("set.language")}>
              <div class="relative w-[320px]">
                <select
                  value={currentLocale()}
                  onChange={(e) => setLocale(e.currentTarget.value as Locale)}
                  class="appearance-none w-full h-10 pl-3.5 pr-9 text-xs rounded-xl bg-ink-50 dark:bg-ink-500
                         border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60
                         focus:border-toucan-400 outline-none cursor-pointer"
                >
                  <For each={LOCALES}>{(l) => (
                    <option value={l.id}>{l.flag}  {l.label}</option>
                  )}</For>
                </select>
                <ChevronDown size={13} class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
              </div>
            </Row>
          </Section>
          </Show>

          <Show when={tab() === "proxy"}>
          <Section icon={<Network size={14} />} title={t("set.proxy")}>
            <div class="flex items-center gap-3">
              <label class="text-xs opacity-70 w-14">{t("set.port")}</label>
              <input
                type="number"
                value={port()}
                onInput={(e) => setPort(Number(e.currentTarget.value) || 8888)}
                class="w-28 h-9 px-3 mono text-sm rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
              />
              <span class={`mono text-xs ${flowsStore.status().running ? "text-toucan-400" : "opacity-50"}`}>
                ● {flowsStore.status().running ? t("set.running", { port: flowsStore.status().port }) : t("set.stopped")}
              </span>
            </div>
            <Row icon={<Globe size={14} />} title={t("set.autoCapture")} hint={t("set.autoCaptureHint")}>
              <button
                onClick={() => prefsStore.setAutoCapture(!prefsStore.prefs().autoCapture)}
                class={`h-9 px-4 text-xs rounded-xl border transition
                  ${prefsStore.prefs().autoCapture
                    ? "bg-toucan-400/15 border-toucan-400/60 text-toucan-400"
                    : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}>
                {prefsStore.prefs().autoCapture ? t("set.enabled") : t("set.disabled")}
              </button>
            </Row>
          </Section>
          </Show>

          <Show when={tab() === "cert"}>
          <Section icon={<ShieldCheck size={14} />} title={t("set.cert")}>
            <p class="text-xs opacity-70 leading-relaxed">{t("set.certHint")}</p>
            <div class="flex items-center gap-2">
              <button onClick={installCa} disabled={busy()}
                class={`h-9 px-4 text-xs rounded-xl flex items-center gap-1.5 border transition
                  ${flowsStore.status().caInstalled
                    ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-500"
                    : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}>
                <ShieldCheck size={13} />
                {flowsStore.status().caInstalled ? t("set.caTrustedBtn") : t("set.installCa")}
              </button>
              <Show when={flowsStore.status().caInstalled}>
                <button onClick={uninstallCa} disabled={busy()}
                  class="h-9 px-4 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 flex items-center gap-1.5">
                  {t("set.uninstallCa")}
                </button>
              </Show>
              <button onClick={exportCa}
                class="h-9 px-4 text-xs rounded-xl border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 flex items-center gap-1.5">
                <Download size={13} /> {t("set.exportCa")}
              </button>
            </div>
          </Section>

          <Section icon={<Lock size={14} />} title={t("set.ssl")}>
            <p class="text-xs opacity-70 leading-relaxed">
              By default, HTTPS traffic is tunneled (not decrypted). Add domains to the SSL Proxying List to inspect their content. Use the "Enable SSL Proxying" button inside any HTTPS capture to add domains quickly.
            </p>
            <div class="flex gap-1 p-1 rounded-xl bg-ink-50 dark:bg-ink-500 w-full">
              <SslOpt mode="allowlist" label="Allow List (default)" current={sslMode} setCurrent={setSslMode} />
              <SslOpt mode="all"       label="Decrypt All"           current={sslMode} setCurrent={setSslMode} />
              <SslOpt mode="blocklist" label="Block List"            current={sslMode} setCurrent={setSslMode} />
            </div>
            <Show when={sslMode() !== "all"}>
              <div>
                <div class="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">
                  {sslMode() === "allowlist" ? "Domains to decrypt (include list):" : "Domains to skip (exclude list):"}
                </div>
                <textarea
                  value={sslHosts()}
                  onInput={(e) => setSslHosts(e.currentTarget.value)}
                  placeholder={"api.example.com\n*.foo.com"}
                  class="w-full h-28 px-3 py-2 mono text-xs rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
                />
              </div>
            </Show>
            <Show when={sslMode() === "all"}>
              <div>
                <div class="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">Always bypass (never decrypt):</div>
                <textarea
                  value={skipHosts()}
                  onInput={(e) => setSkipHosts(e.currentTarget.value)}
                  placeholder={"*.example.com\napi.pinned-app.com"}
                  class="w-full h-24 px-3 py-2 mono text-xs rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-200 dark:border-ink-400/40 focus:border-toucan-400 outline-none resize-y"
                />
                <div class="text-[10px] opacity-50 mt-1">Supports wildcards: *.example.com</div>
              </div>
            </Show>
            <button
              onClick={saveSsl}
              class={`h-9 px-4 text-xs rounded-xl font-medium transition
                ${sslSaved()
                  ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                  : "bg-toucan-400 text-ink-500 hover:bg-toucan-300"}`}
            >{sslSaved() ? t("set.sslSaved") : t("set.sslSave")}</button>
          </Section>

          <Section icon={<Info size={14} />} title={t("set.whyTitle")} >
            <ul class="text-xs opacity-80 space-y-1.5 list-disc pl-5 leading-relaxed">
              <li>{t("set.why1")}</li>
              <li>{t("set.why2")}</li>
              <li>{t("set.why3")}</li>
              <li>{t("set.why4")}</li>
            </ul>
          </Section>
          </Show>

          <Show when={tab() === "mcp"}>
          <Section icon={<Bot size={14} />} title="MCP bridge">
            <p class="text-xs opacity-70 leading-relaxed">
              Exposes captured flows to LLM tools (Claude Desktop, Claude Code, Cursor) via a local-loopback HTTP API. Use the <code class="mono">tucano-mcp</code> npm package as the stdio bridge.
            </p>
            <Row title="Enable MCP bridge" hint="Off by default. Listens on 127.0.0.1 only, requires Bearer token.">
              <button
                onClick={() => setMcpEnabled(!mcpEnabled())}
                class={`h-9 px-4 text-xs rounded-xl border transition
                  ${mcpEnabled()
                    ? "bg-toucan-400/15 border-toucan-400/60 text-toucan-400"
                    : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}>
                {mcpEnabled() ? t("set.enabled") : t("set.disabled")}
              </button>
            </Row>
            <div class="flex items-center gap-3">
              <label class="text-xs opacity-70 w-14">Port</label>
              <input
                type="number"
                value={mcpPort()}
                onInput={(e) => setMcpPort(Number(e.currentTarget.value) || 7878)}
                class="w-28 h-9 px-3 mono text-sm rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 focus:border-toucan-400 outline-none"
              />
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wider opacity-60 mono mb-1">Token</div>
              <div class="flex items-center gap-2">
                <input
                  type={tokenVisible() ? "text" : "password"}
                  readonly
                  value={mcpToken()}
                  class="flex-1 h-9 px-3 mono text-xs rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 outline-none"
                />
                <button
                  onClick={() => setTokenVisible(!tokenVisible())}
                  class="h-9 px-3 text-xs rounded-xl border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"
                >{tokenVisible() ? "Hide" : "Show"}</button>
                <button
                  onClick={() => copyMcp("token")}
                  class={`h-9 px-3 text-xs rounded-xl border flex items-center gap-1.5 transition
                    ${mcpCopied() === "token"
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-500"
                      : "border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}
                ><Copy size={13} /> {mcpCopied() === "token" ? "Copied" : "Copy"}</button>
                <button
                  onClick={rotateMcpToken}
                  class="h-9 px-3 text-xs rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 flex items-center gap-1.5"
                ><RotateCw size={13} /> Rotate</button>
              </div>
            </div>
            <button
              onClick={saveMcp}
              class={`h-9 px-4 text-xs rounded-xl font-medium transition
                ${mcpSaved()
                  ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/40"
                  : "bg-toucan-400 text-ink-500 hover:bg-toucan-300"}`}
            >{mcpSaved() ? "Saved" : "Save"}</button>
          </Section>

          <Section icon={<Plug size={14} />} title="Install in clients">
            <p class="text-xs opacity-70 leading-relaxed">
              One-click install of the <code class="mono">tucano</code> MCP entry into your client's config file. Uses the current port and token — save above first if you just changed them. Restart the client after installing.
            </p>
            <div class="space-y-2">
              <For each={mcpClients()}>{(c) => (
                <div class="flex items-center gap-3 p-3 rounded-xl border border-ink-100 dark:border-ink-400/40">
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium flex items-center gap-2">
                      {c.label}
                      <Show when={c.installed}>
                        <span class="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-500 border border-emerald-500/40">Installed</span>
                      </Show>
                    </div>
                    <div class="text-[11px] mono opacity-60 truncate">{c.path}</div>
                  </div>
                  <Show when={!c.installed} fallback={
                    <button
                      disabled={mcpClientBusy() === c.id}
                      onClick={() => uninstallMcpClient(c.id)}
                      class="h-8 px-3 text-xs rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                    >Remove</button>
                  }>
                    <button
                      disabled={mcpClientBusy() === c.id}
                      onClick={() => installMcpClient(c.id)}
                      class="h-8 px-3 text-xs rounded-lg bg-toucan-400 text-ink-500 hover:bg-toucan-300 disabled:opacity-50"
                    >Install</button>
                  </Show>
                </div>
              )}</For>
            </div>
            <button
              onClick={refreshMcpClients}
              class="h-8 px-3 text-xs rounded-lg border border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60 flex items-center gap-1.5"
            ><RefreshCw size={12} /> Refresh</button>
          </Section>

          <Section icon={<Info size={14} />} title="Client config">
            <p class="text-xs opacity-70 leading-relaxed">
              Paste into your LLM client's MCP config (Claude Desktop: <code class="mono">~/Library/Application Support/Claude/claude_desktop_config.json</code>). Save settings above first — the snippet uses the current port and token. The token is masked below; <strong>Copy</strong> always copies the real value.
            </p>
            <div class="relative">
              <pre class="text-[11px] mono p-3 rounded-xl bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 overflow-auto whitespace-pre">{mcpConfigSnippet()}</pre>
              <button
                onClick={() => copyMcp("config")}
                class={`absolute top-2 right-2 h-7 px-2 text-[11px] rounded-lg border flex items-center gap-1.5 transition
                  ${mcpCopied() === "config"
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-500"
                    : "bg-white dark:bg-ink-600 border-ink-200 dark:border-ink-400/40 hover:border-toucan-400/60"}`}
              ><Copy size={11} /> {mcpCopied() === "config" ? "Copied" : "Copy"}</button>
            </div>
          </Section>
          </Show>

          <Show when={tab() === "icons"}>
          <Section icon={<Info size={14} />} title={t("set.iconsTitle")}>
            <p class="text-xs opacity-70 leading-relaxed">{t("set.iconsHint")}</p>
            <div class="space-y-4 text-xs">
              <IconGroup title={t("set.iconsMethod")}>
                <IconRow icon={<FaSolidCode color="#34D399" size="14px" />} label="GET" hint={t("set.icon.get")} />
                <IconRow icon={<FaSolidFileImport color="#67E8F9" size="14px" />} label="POST" hint={t("set.icon.post")} />
                <IconRow icon={<FaSolidPenToSquare color="#FBBF24" size="14px" />} label="PUT" hint={t("set.icon.put")} />
                <IconRow icon={<FaSolidPencil color="#E879F9" size="14px" />} label="PATCH" hint={t("set.icon.patch")} />
                <IconRow icon={<FaSolidTrash color="#F87171" size="14px" />} label="DELETE" hint={t("set.icon.delete")} />
                <IconRow icon={<FaSolidEye color="#A78BFA" size="14px" />} label="HEAD" hint={t("set.icon.head")} />
                <IconRow icon={<FaSolidGear color="#2DD4BF" size="14px" />} label="OPTIONS" hint={t("set.icon.options")} />
                <IconRow icon={<FaSolidWrench color="#CBD5E1" size="14px" />} label={t("set.icon.otherMethod")} hint={t("set.icon.otherMethodHint")} />
              </IconGroup>

              <IconGroup title={t("set.iconsType")}>
                <IconRow icon={<SiHtml5 color="#E34F26" size="14px" />} label="HTML" hint={t("set.icon.html")} />
                <IconRow icon={<SiCss color="#1572B6" size="14px" />} label="CSS" hint={t("set.icon.css")} />
                <IconRow icon={<SiJavascript color="#F7DF1E" size="14px" />} label="JavaScript" hint={t("set.icon.js")} />
                <IconRow icon={<Braces size={14} class="text-amber-300" />} label="JSON" hint={t("set.icon.json")} />
                <IconRow icon={<FileCode2 size={14} class="text-orange-400" />} label="XML" hint={t("set.icon.xml")} />
                <IconRow icon={<SiGraphql color="#E10098" size="14px" />} label="GraphQL" hint={t("set.icon.graphql")} />
                <IconRow icon={<FileType size={14} class="text-red-300" />} label="PDF" hint={t("set.icon.pdf")} />
                <IconRow icon={<FileText size={14} class="text-teal-300" />} label="Form" hint={t("set.icon.form")} />
                <IconRow icon={<FaSolidFileImage color="#A78BFA" size="14px" />} label={t("set.icon.image")} hint={t("set.icon.imageHint")} />
                <IconRow icon={<Film size={14} class="text-violet-300" />} label="Video" hint={t("set.icon.video")} />
                <IconRow icon={<Music size={14} class="text-violet-300" />} label="Audio" hint={t("set.icon.audio")} />
                <IconRow icon={<Type size={14} class="text-cyan-300" />} label={t("set.icon.font")} hint={t("set.icon.fontHint")} />
                <IconRow icon={<Database size={14} class="text-slate-300" />} label="Binary" hint={t("set.icon.binary")} />
                <IconRow icon={<FileText size={14} class="text-slate-200" />} label="Text" hint={t("set.icon.text")} />
              </IconGroup>

              <IconGroup title={t("set.iconsSpecial")}>
                <IconRow icon={<Plug size={14} class="text-fuchsia-300" />} label="WebSocket" hint={t("set.icon.ws")} />
                <IconRow icon={<Network size={14} class="text-slate-300" />} label="CONNECT" hint={t("set.icon.connect")} />
              </IconGroup>

              <IconGroup title={t("set.iconsStatus")}>
                <IconRow icon={<span class="h-3 w-3 rounded-full bg-slate-300 inline-block" />} label="2xx / —" hint={t("set.icon.s2xx")} />
                <IconRow icon={<span class="h-3 w-3 rounded-full bg-cyan-300 inline-block" />} label="3xx" hint={t("set.icon.s3xx")} />
                <IconRow icon={<span class="h-3 w-3 rounded-full bg-slate-400 inline-block" />} label="304" hint={t("set.icon.s304")} />
                <IconRow icon={<span class="h-3 w-3 rounded-full bg-amber-300 inline-block" />} label="4xx" hint={t("set.icon.s4xx")} />
                <IconRow icon={<span class="h-3 w-3 rounded-full bg-red-300 inline-block" />} label="5xx" hint={t("set.icon.s5xx")} />
              </IconGroup>
            </div>
          </Section>
          </Show>

          <Show when={tab() === "about"}>
          <Section icon={<RefreshCw size={14} />} title={t("set.aboutTitle")}>
            <div class="text-xs space-y-2">
              <div class="flex items-center justify-between gap-3">
                <span class="opacity-70">{t("set.currentVersion")}</span>
                <span class="mono">{appVersion() || "—"}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="opacity-70">{t("set.updateStatus")}</span>
                <span class="mono opacity-80">
                  {updaterStore.state() === "idle" && t("updater.idle")}
                  {updaterStore.state() === "checking" && t("updater.checking")}
                  {updaterStore.state() === "available" && `${t("updater.available")} v${updaterStore.version()}`}
                  {updaterStore.state() === "downloading" && `${t("updater.downloading")} ${Math.round(updaterStore.progress() * 100)}%`}
                  {updaterStore.state() === "ready" && `${t("updater.ready")} v${updaterStore.version()}`}
                  {updaterStore.state() === "upToDate" && t("updater.upToDate")}
                  {updaterStore.state() === "error" && t("updater.error")}
                </span>
              </div>
              <Show when={updaterStore.state() === "error" && updaterStore.error()}>
                <div class="text-[11px] opacity-60 mono break-all">{updaterStore.error()}</div>
              </Show>
              <div class="flex gap-2 pt-1">
                <Show
                  when={updaterStore.state() === "available" || updaterStore.state() === "ready"}
                  fallback={
                    <button
                      onClick={() => updaterStore.check()}
                      disabled={updaterStore.state() === "checking" || updaterStore.state() === "downloading"}
                      class="h-8 px-3 rounded-lg text-xs bg-ink-50 dark:bg-ink-500 hover:bg-ink-100 dark:hover:bg-ink-400/40 disabled:opacity-50"
                    >{t("set.checkUpdates")}</button>
                  }
                >
                  <Show when={updaterStore.state() === "available"}>
                    <button
                      onClick={() => updaterStore.download()}
                      class="h-8 px-3 rounded-lg text-xs bg-toucan-400 text-ink-500 hover:bg-toucan-300"
                    >{t("set.downloadUpdate")}</button>
                  </Show>
                  <Show when={updaterStore.state() === "ready"}>
                    <button
                      onClick={() => updaterStore.restart()}
                      class="h-8 px-3 rounded-lg text-xs bg-toucan-400 text-ink-500 hover:bg-toucan-300"
                    >{t("updater.restart")}</button>
                  </Show>
                </Show>
              </div>
              <Show when={updaterStore.notes()}>
                <pre class="text-[11px] opacity-70 whitespace-pre-wrap font-sans pt-1 leading-relaxed">{updaterStore.notes()}</pre>
              </Show>
            </div>
          </Section>
          </Show>

          <Show when={tab() === "shortcuts"}>
          <Section icon={<Keyboard size={14} />} title={t("set.shortcuts")}>
            <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
              {SHORTCUTS.map(([k, v]) => (
                <div class="flex items-center justify-between gap-3">
                  <span class="opacity-70">{t(v)}</span>
                  <kbd class="mono text-[11px] px-1.5 py-0.5 rounded bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40">{k}</kbd>
                </div>
              ))}
            </div>
          </Section>
          </Show>

            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

function IconGroup(props: { title: string; children: any }) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider opacity-60 mono mb-1.5">{props.title}</div>
      <div class="rounded-xl border border-ink-100 dark:border-ink-400/30 divide-y divide-ink-100 dark:divide-ink-400/20">
        {props.children}
      </div>
    </div>
  );
}

function IconRow(props: { icon: any; label: string; hint: string }) {
  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <div class="w-5 grid place-items-center shrink-0">{props.icon}</div>
      <div class="font-medium mono text-[11px] w-24 shrink-0">{props.label}</div>
      <div class="opacity-70 leading-relaxed">{props.hint}</div>
    </div>
  );
}

function SslOpt(props: { mode: SslMode; label: string; current: () => SslMode; setCurrent: (m: SslMode) => void }) {
  const active = () => props.current() === props.mode;
  return (
    <button
      onClick={() => props.setCurrent(props.mode)}
      class={`flex-1 h-8 rounded-lg flex items-center justify-center text-xs transition truncate px-2
        ${active() ? "bg-white dark:bg-ink-600 text-toucan-400 shadow-sm font-medium" : "opacity-70 hover:opacity-100"}`}
    >{props.label}</button>
  );
}

function ThemeOpt(props: { mode: ThemeMode; icon: any; label: string }) {
  const active = () => themeMode() === props.mode;
  return (
    <button
      onClick={() => setTheme(props.mode)}
      class={`flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 text-xs transition
        ${active() ? "bg-white dark:bg-ink-600 text-toucan-400 shadow-sm" : "opacity-70 hover:opacity-100"}`}
    >{props.icon} {props.label}</button>
  );
}

function Section(props: { icon: any; title: string; children: any }) {
  return (
    <div class="px-5 py-4 border-b border-ink-100 dark:border-ink-400/20 last:border-0 space-y-3">
      <div class="flex items-center gap-2 text-toucan-400">
        {props.icon}<span class="text-xs uppercase tracking-wider font-semibold">{props.title}</span>
      </div>
      {props.children}
    </div>
  );
}

function Row(props: { icon?: any; title: string; hint?: string; children: any }) {
  return (
    <div class="flex items-start gap-3">
      <Show when={props.icon}><div class="mt-1 opacity-70">{props.icon}</div></Show>
      <div class="flex-1 min-w-0">
        <div class="text-sm">{props.title}</div>
        {props.hint && <div class="text-xs opacity-60 mt-0.5 leading-relaxed">{props.hint}</div>}
      </div>
      <div class="shrink-0">{props.children}</div>
    </div>
  );
}
