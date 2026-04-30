import { createMemo, createSignal, Show } from "solid-js";
import { Copy, Check, Download, WrapText, Sparkles } from "lucide-solid";
import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import JsonViewer from "../viewers/JsonViewer";
import RawViewer from "../viewers/RawViewer";
import HexViewer from "../viewers/HexViewer";
import ImageViewer from "../viewers/ImageViewer";
import HtmlViewer from "../viewers/HtmlViewer";
import FormViewer from "../viewers/FormViewer";
import { beautify, isBeautifiable, type BeautifyLang } from "../lib/format";
import { t } from "../lib/i18n";

type Mode = "auto" | "json" | "xml" | "html" | "form" | "raw" | "hex" | "image";

function detect(ct: string | null): Mode {
  if (!ct) return "raw";
  const c = ct.toLowerCase();
  if (c.includes("json")) return "json";
  if (c.includes("xml")) return "xml";
  if (c.includes("html")) return "html";
  if (c.includes("x-www-form-urlencoded") || c.includes("multipart/form-data")) return "form";
  if (c.startsWith("image/")) return "image";
  if (c.startsWith("text/")) return "raw";
  return "hex";
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function utf8ToBase64(s: string): string {
  // Encode any UTF-8 string (including multi-byte) to base64.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "bin";
  const sub = ct.split(";")[0].split("/")[1] ?? "bin";
  const map: Record<string, string> = {
    "javascript": "js",
    "x-javascript": "js",
    "plain": "txt",
    "html": "html",
    "json": "json",
    "xml": "xml",
    "jpeg": "jpg",
  };
  return map[sub] ?? (sub.replace(/[^a-z0-9]/gi, "") || "bin");
}

const MODES: Mode[] = ["auto", "json", "xml", "html", "form", "raw", "hex", "image"];

export default function BodyView(props: {
  body: string | null;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const [mode, setMode] = createSignal<Mode>("auto");
  const [copied, setCopied] = createSignal(false);
  const [pretty, setPretty] = createSignal(true);
  const [wrap, setWrap] = createSignal(true);

  const effective = createMemo<Mode>(() => mode() === "auto" ? detect(props.contentType) : mode());

  // What the underlying viewer should render. Beautify only applies to text
  // formats and only when explicitly enabled — turning it off shows the
  // server's wire bytes verbatim.
  const displayText = createMemo<string>(() => {
    if (!props.body) return "";
    if (!pretty()) return props.body;
    const m = effective();
    if (isBeautifiable(m as BeautifyLang)) return beautify(props.body, m as BeautifyLang);
    return props.body;
  });

  const canBeautify = () => isBeautifiable(effective() as BeautifyLang);
  const canWrap = () => {
    const m = effective();
    return m === "xml" || m === "html" || m === "raw";
  };

  const byteSize = () => {
    if (!props.body) return 0;
    return props.encoding === "base64"
      ? Math.floor((props.body.length * 3) / 4)
      : new TextEncoder().encode(props.body).length;
  };

  const copyBody = async () => {
    if (!props.body) return;
    let text = props.body;
    if (props.encoding === "base64") {
      try { text = atob(props.body); } catch {}
    }
    if (pretty() && isBeautifiable(effective() as BeautifyLang)) {
      text = beautify(text, effective() as BeautifyLang);
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const downloadBody = async () => {
    if (!props.body) return;
    const ext = extFromContentType(props.contentType);
    const path = await save({
      defaultPath: `body.${ext}`,
      filters: [{ name: props.contentType ?? "File", extensions: [ext] }],
    });
    if (!path) return;
    try {
      if (props.encoding === "base64") {
        await ipc.writeBinaryFile(path, props.body);
      } else {
        // Text content — but encode as base64 to preserve any byte that
        // came in via Latin-1 fallback. write_binary_file roundtrips
        // exact bytes; write_text_file would re-encode through Rust UTF-8.
        await ipc.writeBinaryFile(path, utf8ToBase64(props.body));
      }
    } catch (e) { console.error("save body failed", e); alert(String(e)); }
  };

  const modeBtn = (m: Mode) =>
    `px-2 h-7 rounded-lg transition mono text-[11px] uppercase tracking-wider ${
      mode() === m
        ? "bg-toucan-400 text-ink-500 font-medium"
        : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
    }`;
  const toggleBtn = (active: boolean, enabled: boolean) =>
    `h-7 px-2 rounded-lg flex items-center gap-1 text-[11px] mono transition ${
      !enabled ? "opacity-30 pointer-events-none" :
      active
        ? "bg-toucan-400/15 border border-toucan-400/60 text-toucan-400"
        : "border border-transparent hover:bg-ink-100 dark:hover:bg-ink-400/20 opacity-70 hover:opacity-100"
    }`;
  const actionBtn = "h-7 px-2 rounded-lg flex items-center gap-1 text-[11px] hover:bg-ink-100 dark:hover:bg-ink-400/20 opacity-70 hover:opacity-100";
  const sep = <div class="w-px h-4 bg-ink-100 dark:bg-ink-400/30 mx-0.5 shrink-0" />;

  return (
    <div class="h-full flex flex-col">
      <div class="flex items-center gap-1 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        {/* View mode picker */}
        <div class="flex items-center gap-0.5">
          {MODES.map((m) => (
            <button onClick={() => setMode(m)} class={modeBtn(m)} title={m}>{m}</button>
          ))}
        </div>

        {sep}

        {/* Display tools (beautify / wrap) */}
        <button
          onClick={() => setPretty((v) => !v)}
          class={toggleBtn(pretty(), canBeautify())}
          title={t("body.beautify")}
        >
          <Sparkles size={12} /> {t("body.beautify")}
        </button>
        <button
          onClick={() => setWrap((v) => !v)}
          class={toggleBtn(wrap(), canWrap())}
          title={t("body.wrap")}
        >
          <WrapText size={12} /> {t("body.wrap")}
        </button>

        {/* Spacer + content metadata */}
        <span class="ml-auto opacity-50 mono text-[11px] truncate pl-2">
          {props.contentType ?? t("body.noCt")}
          <Show when={props.body}>
            <span class="opacity-70 mx-1">·</span>
            <span class="opacity-70">{fmtSize(byteSize())}</span>
          </Show>
        </span>

        <Show when={props.body}>
          {sep}
          <button onClick={copyBody} class={actionBtn} title={t("body.copy")}>
            {copied() ? <Check size={12} /> : <Copy size={12} />}
            {copied() ? t("body.copied") : t("body.copy")}
          </button>
          <button onClick={downloadBody} class={actionBtn} title={t("body.save")}>
            <Download size={12} /> {t("body.save")}
          </button>
        </Show>
      </div>

      <div class="flex-1 min-h-0 overflow-hidden">
        <Show when={props.body} fallback={<div class="p-4 opacity-50 text-sm">{t("body.empty")}</div>}>
          <>
            {effective() === "json" && <JsonViewer text={displayText()} />}
            {effective() === "xml" && <RawViewer text={displayText()} lang="xml" wrap={wrap()} />}
            {effective() === "html" && <HtmlViewer text={displayText()} wrap={wrap()} />}
            {effective() === "form" && <FormViewer body={props.body!} encoding={props.encoding} contentType={props.contentType} />}
            {effective() === "raw" && <RawViewer text={displayText()} lang="raw" wrap={wrap()} />}
            {effective() === "hex" && <HexViewer text={props.body!} encoding={props.encoding} />}
            {effective() === "image" && <ImageViewer body={props.body!} encoding={props.encoding} contentType={props.contentType} />}
          </>
        </Show>
      </div>
    </div>
  );
}
