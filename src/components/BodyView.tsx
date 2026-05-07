import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Copy, Check, Download, WrapText, Sparkles, ChevronDown, Maximize2, Minimize2, Binary } from "lucide-solid";
import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import JsonViewer from "../viewers/JsonViewer";
import RawViewer from "../viewers/RawViewer";
import HexViewer from "../viewers/HexViewer";
import ImageViewer from "../viewers/ImageViewer";
import HtmlViewer from "../viewers/HtmlViewer";
import XmlViewer from "../viewers/XmlViewer";
import FormViewer from "../viewers/FormViewer";
import { beautify, isBeautifiable, type BeautifyLang } from "../lib/format";
import { t } from "../lib/i18n";

type Mode = "auto" | "json" | "xml" | "html" | "form" | "raw" | "hex" | "image";

// Track the BodyView the user is currently interacting with so a global
// Cmd+F lands in the right pane (request vs response).
let activeBody: HTMLElement | null = null;

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
  const [full, setFull] = createSignal(false);
  const [decoded, setDecoded] = createSignal(false);
  let rootEl!: HTMLDivElement;
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && full()) { e.stopPropagation(); setFull(false); return; }
    // Cmd+F is owned by the viewers' useFindShell — they each render their
    // own FindBar above the content.
  };
  window.addEventListener("keydown", onWindowKey, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onWindowKey, true);
    if (activeBody === rootEl) activeBody = null;
  });
  const onRootEnter = () => { activeBody = rootEl; };

  // When Decode is active and encoding is base64, expose body as Latin-1 text.
  const decodedBody = createMemo<string | null>(() => {
    if (!decoded() || props.encoding !== "base64" || !props.body) return props.body ?? null;
    try {
      const bin = atob(props.body);
      return bin; // Latin-1 string
    } catch { return props.body ?? null; }
  });
  const effectiveEncoding = () => decoded() && props.encoding === "base64" ? "utf8" : props.encoding;

  const effective = createMemo<Mode>(() => {
    if (mode() !== "auto") return mode();
    if (decoded() && props.encoding === "base64") return "raw";
    return detect(props.contentType);
  });

  const displayText = createMemo<string>(() => {
    const body = decodedBody();
    if (!body) return "";
    if (!pretty()) return body;
    const m = effective();
    if (isBeautifiable(m as BeautifyLang)) return beautify(body, m as BeautifyLang);
    return body;
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

  const iconBtn = (active: boolean, enabled = true) =>
    `h-7 w-7 grid place-items-center rounded-lg transition shrink-0 ${
      !enabled ? "opacity-25 pointer-events-none" :
      active
        ? "bg-toucan-400/15 text-toucan-400"
        : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
    }`;

  return (
    <div ref={rootEl} onMouseEnter={onRootEnter} class={full()
      ? "fixed inset-0 z-50 flex flex-col bg-white dark:bg-ink-500"
      : "h-full flex flex-col"
    }>
      <div class="flex items-center gap-1.5 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        {/* Mode dropdown — replaces 8-button row */}
        <div class="relative shrink-0">
          <select
            value={mode()}
            onChange={(e) => setMode(e.currentTarget.value as Mode)}
            class="appearance-none h-7 pl-2.5 pr-7 text-[11px] mono uppercase tracking-wider rounded-lg
                   bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40
                   hover:border-toucan-400/60 focus:border-toucan-400 outline-none cursor-pointer"
          >
            {MODES.map((m) => (
              <option value={m}>{m === effective() && m !== mode() ? `${m} (auto)` : m}</option>
            ))}
          </select>
          <ChevronDown size={11} class="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
        </div>

        <button onClick={() => setPretty((v) => !v)} class={iconBtn(pretty(), canBeautify())} title={t("body.beautify")}>
          <Sparkles size={13} />
        </button>
        <button onClick={() => setWrap((v) => !v)} class={iconBtn(wrap(), canWrap())} title={t("body.wrap")}>
          <WrapText size={13} />
        </button>
        <Show when={props.encoding === "base64"}>
          <button onClick={() => setDecoded((v) => !v)} class={iconBtn(decoded())} title="Decode (show as text)">
            <Binary size={13} />
          </button>
        </Show>

        <span class="ml-auto opacity-50 mono text-[11px] truncate pl-2">
          {props.contentType ?? t("body.noCt")}
          <Show when={props.body}>
            <span class="opacity-70 mx-1">·</span>
            <span class="opacity-70">{fmtSize(byteSize())}</span>
          </Show>
        </span>

        <Show when={props.body}>
          <button onClick={copyBody} class={iconBtn(false)} title={copied() ? t("body.copied") : t("body.copy")}>
            {copied() ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button onClick={downloadBody} class={iconBtn(false)} title={t("body.save")}>
            <Download size={13} />
          </button>
        </Show>
        <button
          onClick={() => setFull((v) => !v)}
          class={iconBtn(false)}
          title={full() ? t("body.exitFullscreen") : t("body.fullscreen")}
        >
          {full() ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-hidden">
        <Show when={decodedBody()} fallback={<div class="p-4 opacity-50 text-sm">{t("body.empty")}</div>}>
          <>
            {effective() === "json" && <JsonViewer text={displayText()} />}
            {effective() === "xml" && <XmlViewer text={displayText()} wrap={wrap()} />}
            {effective() === "html" && <HtmlViewer text={displayText()} wrap={wrap()} />}
            {effective() === "form" && <FormViewer body={decodedBody()!} encoding={effectiveEncoding() as "utf8" | "base64"} contentType={props.contentType} />}
            {effective() === "raw" && <RawViewer text={displayText()} lang="raw" wrap={wrap()} />}
            {effective() === "hex" && <HexViewer text={decodedBody()!} encoding={effectiveEncoding() as "utf8" | "base64"} />}
            {effective() === "image" && <ImageViewer body={decodedBody()!} encoding={effectiveEncoding() as "utf8" | "base64"} contentType={props.contentType} />}
          </>
        </Show>
      </div>
    </div>
  );
}
