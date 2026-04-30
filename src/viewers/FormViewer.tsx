import { createMemo, createSignal, For, Show } from "solid-js";
import { Copy, Check } from "lucide-solid";

type Part = {
  name: string;
  filename?: string;
  contentType?: string;
  value: string;
  isText: boolean;
  size: number;
};

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function parseUrlEncoded(text: string): Part[] {
  const out: Part[] = [];
  // URLSearchParams handles + and percent-encoding.
  const params = new URLSearchParams(text);
  params.forEach((value, name) => {
    out.push({ name, value, isText: true, size: new TextEncoder().encode(value).length });
  });
  return out;
}

function bodyToBytes(body: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return new TextEncoder().encode(body);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function bytesToString(bytes: Uint8Array): string {
  // Try UTF-8; fall back to latin1 to preserve bytes for non-text parts.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function looksTextual(bytes: Uint8Array): boolean {
  // Reject if contains a NUL or too many control bytes.
  let ctrl = 0;
  const sample = Math.min(bytes.length, 1024);
  for (let i = 0; i < sample; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / Math.max(sample, 1) < 0.05;
}

function parseDisposition(line: string): { name?: string; filename?: string } {
  const out: { name?: string; filename?: string } = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1] === "name") out.name = m[2];
    else if (m[1] === "filename") out.filename = m[2];
  }
  return out;
}

function parseMultipart(bytes: Uint8Array, boundary: string): Part[] {
  const enc = new TextEncoder();
  const dashBoundary = enc.encode(`--${boundary}`);
  const out: Part[] = [];

  let pos = indexOfBytes(bytes, dashBoundary);
  if (pos < 0) return out;
  pos += dashBoundary.length;

  while (pos < bytes.length) {
    // Skip CRLF after boundary, or detect closing "--".
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break; // "--" → end
    if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
    else if (bytes[pos] === 0x0a) pos += 1;

    // Headers end at CRLFCRLF (or LFLF tolerating).
    const headerEnd = (() => {
      const a = indexOfBytes(bytes, enc.encode("\r\n\r\n"), pos);
      const b = indexOfBytes(bytes, enc.encode("\n\n"), pos);
      if (a < 0) return b;
      if (b < 0) return a;
      return Math.min(a, b);
    })();
    if (headerEnd < 0) break;
    const headerStr = new TextDecoder("latin1").decode(bytes.subarray(pos, headerEnd));
    const bodyStart = headerEnd + (bytes[headerEnd] === 0x0d ? 4 : 2);

    // Find next boundary.
    const nextBoundary = indexOfBytes(bytes, dashBoundary, bodyStart);
    if (nextBoundary < 0) break;
    // Body is up to CRLF before the boundary.
    let bodyEnd = nextBoundary;
    if (bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    else if (bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 1;

    const partBytes = bytes.subarray(bodyStart, bodyEnd);

    // Parse headers for disposition / content-type.
    let name = "";
    let filename: string | undefined;
    let contentType: string | undefined;
    for (const line of headerStr.split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (lower.startsWith("content-disposition:")) {
        const d = parseDisposition(line);
        name = d.name ?? "";
        filename = d.filename;
      } else if (lower.startsWith("content-type:")) {
        contentType = line.slice(line.indexOf(":") + 1).trim();
      }
    }

    const isText = !filename && looksTextual(partBytes);
    out.push({
      name: name || "(unnamed)",
      filename,
      contentType,
      value: isText ? bytesToString(partBytes) : "",
      isText,
      size: partBytes.length,
    });

    pos = nextBoundary + dashBoundary.length;
  }
  return out;
}

function getBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

export default function FormViewer(props: {
  body: string;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const parts = createMemo<Part[]>(() => {
    const ct = (props.contentType ?? "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = props.encoding === "base64"
        ? (() => { try { return atob(props.body); } catch { return props.body; } })()
        : props.body;
      return parseUrlEncoded(text);
    }
    if (ct.includes("multipart/")) {
      const boundary = getBoundary(props.contentType);
      if (!boundary) return [];
      return parseMultipart(bodyToBytes(props.body, props.encoding), boundary);
    }
    return [];
  });

  const [copied, setCopied] = createSignal<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {}
  };
  const btn = "h-6 px-2 rounded-md text-[10px] flex items-center gap-1 bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 hover:border-toucan-400 hover:text-toucan-400";

  return (
    <div class="text-xs">
      <Show
        when={parts().length > 0}
        fallback={<div class="p-4 opacity-60">No form fields detected.</div>}
      >
        <table class="w-full">
          <thead class="text-[10px] uppercase tracking-wider opacity-60 mono">
            <tr class="border-b border-ink-100 dark:border-ink-400/20">
              <th class="text-left font-normal py-2 px-4 w-1/4">Field</th>
              <th class="text-left font-normal py-2 px-4">Value</th>
            </tr>
          </thead>
          <tbody>
            <For each={parts()}>
              {(p, i) => {
                const kId = `fk${i()}`;
                const vId = `fv${i()}`;
                const lId = `fl${i()}`;
                return (
                  <tr class="group border-b border-ink-100/60 dark:border-ink-400/10 align-top hover:bg-toucan-400/5">
                    <td class="py-2 px-4 mono break-all">
                      <div class="font-medium">{p.name}</div>
                      <Show when={p.filename}>
                        <div class="opacity-60 text-[10px] mt-1">filename: {p.filename}</div>
                      </Show>
                      <Show when={p.contentType}>
                        <div class="opacity-60 text-[10px]">{p.contentType}</div>
                      </Show>
                      <div class="opacity-50 text-[10px] mt-1">{fmtSize(p.size)}</div>
                    </td>
                    <td class="py-2 px-4 mono break-all whitespace-pre-wrap relative">
                      <div class="flex gap-2">
                        <span class="flex-1 min-w-0 break-all">
                          <Show
                            when={p.isText}
                            fallback={<span class="opacity-50 italic">(binary, {fmtSize(p.size)})</span>}
                          >
                            {p.value}
                          </Show>
                        </span>
                        <Show when={p.isText}>
                          <span class="flex gap-1 opacity-0 group-hover:opacity-100 transition shrink-0 self-start">
                            <button onClick={() => copy(kId, p.name)} title="Copy key" class={btn}>
                              {copied() === kId ? <Check size={11} /> : <Copy size={11} />} key
                            </button>
                            <button onClick={() => copy(vId, p.value)} title="Copy value" class={btn}>
                              {copied() === vId ? <Check size={11} /> : <Copy size={11} />} value
                            </button>
                            <button onClick={() => copy(lId, `${p.name}=${p.value}`)} title="Copy key=value" class={btn}>
                              {copied() === lId ? <Check size={11} /> : <Copy size={11} />} both
                            </button>
                          </span>
                        </Show>
                      </div>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
