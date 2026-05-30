import { useMemo, useState } from "react";
import { Copy, Check, MoreHorizontal } from "lucide-react";

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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function looksTextual(bytes: Uint8Array): boolean {
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
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break; // "--" → end
    if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
    else if (bytes[pos] === 0x0a) pos += 1;

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

    const nextBoundary = indexOfBytes(bytes, dashBoundary, bodyStart);
    if (nextBoundary < 0) break;
    let bodyEnd = nextBoundary;
    if (bytes[bodyEnd - 2] === 0x0d && bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    else if (bytes[bodyEnd - 1] === 0x0a) bodyEnd -= 1;

    const partBytes = bytes.subarray(bodyStart, bodyEnd);

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

export default function FormViewer({ body, encoding, contentType }: {
  body: string;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const parts = useMemo<Part[]>(() => {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = encoding === "base64"
        ? (() => { try { return atob(body); } catch { return body; } })()
        : body;
      return parseUrlEncoded(text);
    }
    if (ct.includes("multipart/")) {
      const boundary = getBoundary(contentType);
      if (!boundary) return [];
      return parseMultipart(bodyToBytes(body, encoding), boundary);
    }
    return [];
  }, [body, encoding, contentType]);

  const [copied, setCopied] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setOpenRow(null);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {}
  };
  const item = "w-full text-left px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 hover:bg-toucan-400/10 hover:text-toucan-400";

  if (parts.length === 0) {
    return <div className="text-xs"><div className="p-4 opacity-60">No form fields detected.</div></div>;
  }

  return (
    <div className="text-xs">
      <table className="w-full">
        <thead className="text-[10px] uppercase tracking-wider opacity-60 mono">
          <tr className="border-b border-ink-100 dark:border-ink-400/20">
            <th className="text-left font-normal py-2 px-4 w-1/4">Field</th>
            <th className="text-left font-normal py-2 px-4">Value</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p, i) => {
            const kId = `fk${i}`, vId = `fv${i}`, lId = `fl${i}`;
            return (
              <tr key={i} className="group border-b border-ink-100/60 dark:border-ink-400/10 align-top hover:bg-toucan-400/5">
                <td className="py-2 px-4 mono break-all">
                  <div className="font-medium">{p.name}</div>
                  {p.filename && <div className="opacity-60 text-[10px] mt-1">filename: {p.filename}</div>}
                  {p.contentType && <div className="opacity-60 text-[10px]">{p.contentType}</div>}
                  <div className="opacity-50 text-[10px] mt-1">{fmtSize(p.size)}</div>
                </td>
                <td className="py-2 px-4 mono [overflow-wrap:anywhere] whitespace-pre-wrap relative">
                  <div className="flex gap-2">
                    <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">
                      {p.isText ? p.value : <span className="opacity-50 italic">(binary, {fmtSize(p.size)})</span>}
                    </span>
                    {p.isText && (
                      <div className="relative shrink-0 self-start">
                        <button
                          onClick={() => setOpenRow(openRow === i ? null : i)}
                          title="Copy"
                          className="h-6 w-6 grid place-items-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-ink-100 dark:hover:bg-ink-400/20 hover:text-toucan-400 transition"
                        ><MoreHorizontal size={13} /></button>
                        {openRow === i && (
                          <>
                            <div className="fixed inset-0 z-30" onClick={() => setOpenRow(null)} />
                            <div className="absolute z-40 right-0 top-7 min-w-[160px] bg-white dark:bg-ink-500 border border-ink-100 dark:border-ink-400/40 rounded-xl shadow-xl py-1">
                              <button onClick={() => copy(kId, p.name)} className={item}>
                                {copied === kId ? <Check size={11} /> : <Copy size={11} />} Copy key
                              </button>
                              <button onClick={() => copy(vId, p.value)} className={item}>
                                {copied === vId ? <Check size={11} /> : <Copy size={11} />} Copy value
                              </button>
                              <button onClick={() => copy(lId, `${p.name}=${p.value}`)} className={item}>
                                {copied === lId ? <Check size={11} /> : <Copy size={11} />} Copy key=value
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
