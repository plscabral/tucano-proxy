import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check, Download, WrapText, Sparkles, ChevronDown, Maximize2, Minimize2, Binary } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import JsonViewer from "@/viewers/JsonViewer";
import RawViewer from "@/viewers/RawViewer";
import HexViewer from "@/viewers/HexViewer";
import ImageViewer from "@/viewers/ImageViewer";
import HtmlViewer from "@/viewers/HtmlViewer";
import XmlViewer from "@/viewers/XmlViewer";
import FormViewer from "@/viewers/FormViewer";
import { beautify, isBeautifiable, type BeautifyLang } from "@/lib/format";
import { t } from "@/lib/i18n";

type Mode = "auto" | "json" | "xml" | "html" | "form" | "raw" | "hex" | "image";

// Track the BodyView the user is currently interacting with so a global Cmd+F
// lands in the right pane (request vs response).
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
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "bin";
  const sub = ct.split(";")[0].split("/")[1] ?? "bin";
  const map: Record<string, string> = {
    "javascript": "js", "x-javascript": "js", "plain": "txt",
    "html": "html", "json": "json", "xml": "xml", "jpeg": "jpg",
  };
  return map[sub] ?? (sub.replace(/[^a-z0-9]/gi, "") || "bin");
}

const MODES: Mode[] = ["auto", "json", "xml", "html", "form", "raw", "hex", "image"];

export default function BodyView({ body, encoding, contentType }: {
  body: string | null;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const [mode, setMode] = useState<Mode>("auto");
  const [copied, setCopied] = useState(false);
  const [pretty, setPretty] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [full, setFull] = useState(false);
  const [decoded, setDecoded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const fullRef = useRef(full);
  fullRef.current = full;
  useEffect(() => {
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && fullRef.current) { e.stopPropagation(); setFull(false); }
    };
    window.addEventListener("keydown", onWindowKey, true);
    return () => {
      window.removeEventListener("keydown", onWindowKey, true);
      if (activeBody === rootRef.current) activeBody = null;
    };
  }, []);
  const onRootEnter = () => { activeBody = rootRef.current; };

  const decodedBody = useMemo<string | null>(() => {
    if (!decoded || encoding !== "base64" || !body) return body ?? null;
    try { return atob(body); } catch { return body ?? null; }
  }, [decoded, encoding, body]);
  const effectiveEncoding = (): "utf8" | "base64" => (decoded && encoding === "base64" ? "utf8" : encoding);

  const effective = useMemo<Mode>(() => {
    if (mode !== "auto") return mode;
    if (decoded && encoding === "base64") return "raw";
    return detect(contentType);
  }, [mode, decoded, encoding, contentType]);

  const displayText = useMemo<string>(() => {
    if (!decodedBody) return "";
    if (!pretty) return decodedBody;
    if (isBeautifiable(effective as BeautifyLang)) return beautify(decodedBody, effective as BeautifyLang);
    return decodedBody;
  }, [decodedBody, pretty, effective]);

  const canBeautify = isBeautifiable(effective as BeautifyLang);
  const canWrap = effective === "xml" || effective === "html" || effective === "raw";

  const byteSize = () => {
    if (!body) return 0;
    return encoding === "base64"
      ? Math.floor((body.length * 3) / 4)
      : new TextEncoder().encode(body).length;
  };

  const copyBody = async () => {
    if (!body) return;
    let text = body;
    if (encoding === "base64") { try { text = atob(body); } catch {} }
    if (pretty && isBeautifiable(effective as BeautifyLang)) text = beautify(text, effective as BeautifyLang);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const downloadBody = async () => {
    if (!body) return;
    const ext = extFromContentType(contentType);
    const path = await save({ defaultPath: `body.${ext}`, filters: [{ name: contentType ?? "File", extensions: [ext] }] });
    if (!path) return;
    try {
      if (encoding === "base64") await ipc.writeBinaryFile(path, body);
      else await ipc.writeBinaryFile(path, utf8ToBase64(body));
    } catch (e) { console.error("save body failed", e); alert(String(e)); }
  };

  const iconBtn = (active: boolean, enabled = true) =>
    `h-7 w-7 grid place-items-center rounded-lg transition shrink-0 ${
      !enabled ? "opacity-25 pointer-events-none" :
      active ? "bg-toucan-400/15 text-toucan-400" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"
    }`;

  return (
    <div ref={rootRef} onMouseEnter={onRootEnter} className={full
      ? "fixed inset-0 z-50 flex flex-col bg-white dark:bg-ink-500"
      : "h-full flex flex-col"
    }>
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs border-b border-ink-100 dark:border-ink-400/20">
        <div className="relative shrink-0">
          <select
            value={mode}
            onChange={(e) => setMode(e.currentTarget.value as Mode)}
            className="appearance-none h-7 pl-2.5 pr-7 text-[11px] mono uppercase tracking-wider rounded-lg
                       bg-ink-50 dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40
                       hover:border-toucan-400/60 focus:border-toucan-400 outline-none cursor-pointer"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>{m === effective && m !== mode ? `${m} (auto)` : m}</option>
            ))}
          </select>
          <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />
        </div>

        <button onClick={() => setPretty((v) => !v)} className={iconBtn(pretty, canBeautify)} title={t("body.beautify")}>
          <Sparkles size={13} />
        </button>
        <button onClick={() => setWrap((v) => !v)} className={iconBtn(wrap, canWrap)} title={t("body.wrap")}>
          <WrapText size={13} />
        </button>
        {encoding === "base64" && (
          <button onClick={() => setDecoded((v) => !v)} className={iconBtn(decoded)} title="Decode (show as text)">
            <Binary size={13} />
          </button>
        )}

        <span className="ml-auto opacity-50 mono text-[11px] truncate pl-2">
          {contentType ?? t("body.noCt")}
          {body && (
            <>
              <span className="opacity-70 mx-1">·</span>
              <span className="opacity-70">{fmtSize(byteSize())}</span>
            </>
          )}
        </span>

        {body && (
          <>
            <button onClick={copyBody} className={iconBtn(false)} title={copied ? t("body.copied") : t("body.copy")}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button onClick={downloadBody} className={iconBtn(false)} title={t("body.save")}>
              <Download size={13} />
            </button>
          </>
        )}
        <button onClick={() => setFull((v) => !v)} className={iconBtn(false)} title={full ? t("body.exitFullscreen") : t("body.fullscreen")}>
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {!decodedBody ? (
          <div className="p-4 opacity-50 text-sm">{t("body.empty")}</div>
        ) : (
          <>
            {effective === "json" && <JsonViewer text={displayText} />}
            {effective === "xml" && <XmlViewer text={displayText} wrap={wrap} />}
            {effective === "html" && <HtmlViewer text={displayText} wrap={wrap} />}
            {effective === "form" && <FormViewer body={decodedBody} encoding={effectiveEncoding()} contentType={contentType} />}
            {effective === "raw" && <RawViewer text={displayText} lang="raw" wrap={wrap} />}
            {effective === "hex" && <HexViewer text={decodedBody} encoding={effectiveEncoding()} />}
            {effective === "image" && <ImageViewer body={decodedBody} encoding={effectiveEncoding()} contentType={contentType} />}
          </>
        )}
      </div>
    </div>
  );
}
