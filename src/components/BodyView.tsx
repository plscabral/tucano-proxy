import { createMemo, createSignal, Show } from "solid-js";
import { Copy, Check, Download, WrapText } from "lucide-solid";
import JsonViewer from "../viewers/JsonViewer";
import RawViewer from "../viewers/RawViewer";
import HexViewer from "../viewers/HexViewer";
import ImageViewer from "../viewers/ImageViewer";
import HtmlViewer from "../viewers/HtmlViewer";
import { t } from "../lib/i18n";

type Mode = "auto" | "json" | "xml" | "html" | "raw" | "hex" | "image";

function detect(ct: string | null): Mode {
  if (!ct) return "raw";
  const c = ct.toLowerCase();
  if (c.includes("json")) return "json";
  if (c.includes("xml")) return "xml";
  if (c.includes("html")) return "html";
  if (c.startsWith("image/")) return "image";
  if (c.startsWith("text/")) return "raw";
  return "hex";
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function bodyToBlob(body: string, encoding: "utf8" | "base64", contentType: string | null): Blob {
  if (encoding === "base64") {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: contentType || "application/octet-stream" });
  }
  return new Blob([body], { type: contentType || "text/plain" });
}

export default function BodyView(props: {
  body: string | null;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const [mode, setMode] = createSignal<Mode>("auto");
  const [copied, setCopied] = createSignal(false);
  const effective = createMemo<Mode>(() => mode() === "auto" ? detect(props.contentType) : mode());
  const modes: Mode[] = ["auto", "json", "xml", "html", "raw", "hex", "image"];

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
    if (effective() === "json") {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const downloadBody = () => {
    if (!props.body) return;
    const blob = bodyToBlob(props.body, props.encoding, props.contentType);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ext = (props.contentType || "").split("/")[1]?.split(";")[0] || "bin";
    a.download = `body.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="h-full flex flex-col">
      <div class="flex items-center gap-1.5 px-4 py-2.5 text-xs border-b border-ink-100 dark:border-ink-400/20">
        <span class="opacity-60 mr-1 text-[10px] uppercase tracking-wider mono">{t("body.view")}</span>
        {modes.map((m) => (
          <button onClick={() => setMode(m)}
            class={`px-2.5 h-7 rounded-lg transition mono text-[11px]
              ${mode() === m ? "bg-toucan-400 text-ink-500 font-medium" : "opacity-60 hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20"}`}>
            {m}
          </button>
        ))}
        <span class="ml-auto opacity-50 mono text-[11px] truncate">
          {props.contentType ?? t("body.noCt")}
          <Show when={props.body}>
            <span class="opacity-70 mx-1">·</span>
            <span class="opacity-70">{fmtSize(byteSize())}</span>
          </Show>
        </span>
        <Show when={props.body}>
          <button onClick={copyBody}
            class="h-7 px-2.5 rounded-lg flex items-center gap-1 text-[11px] hover:bg-ink-100 dark:hover:bg-ink-400/20"
            title="Copy body">
            {copied() ? <Check size={12} /> : <Copy size={12} />}
            {copied() ? "copied" : "copy"}
          </button>
          <button onClick={downloadBody}
            class="h-7 px-2.5 rounded-lg flex items-center gap-1 text-[11px] hover:bg-ink-100 dark:hover:bg-ink-400/20"
            title="Save as file">
            <Download size={12} /> save
          </button>
        </Show>
      </div>
      <div class="flex-1 overflow-auto scroll-thin">
        <Show when={props.body} fallback={<div class="p-4 opacity-50 text-sm">{t("body.empty")}</div>}>
          {(body) => (
            <>
              {effective() === "json" && <JsonViewer text={body()} />}
              {effective() === "xml" && <RawViewer text={body()} lang="xml" />}
              {effective() === "html" && <HtmlViewer text={body()} />}
              {effective() === "raw" && <RawViewer text={body()} lang="raw" />}
              {effective() === "hex" && <HexViewer text={body()} encoding={props.encoding} />}
              {effective() === "image" && <ImageViewer body={body()} encoding={props.encoding} contentType={props.contentType} />}
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
