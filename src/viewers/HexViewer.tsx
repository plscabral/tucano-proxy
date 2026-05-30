function bytes(text: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") {
    const bin = atob(text);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return new TextEncoder().encode(text);
}

export default function HexViewer({ text, encoding }: { text: string; encoding: "utf8" | "base64" }) {
  const b = bytes(text, encoding);
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const slice = b.slice(i, i + 16);
    const hex = Array.from(slice).map((x) => x.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice).map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }
  return <pre className="mono text-xs p-3 whitespace-pre">{lines.join("\n")}</pre>;
}
