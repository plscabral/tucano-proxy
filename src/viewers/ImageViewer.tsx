export default function ImageViewer({
  body,
  encoding,
  contentType,
}: {
  body: string;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const ct = contentType ?? "image/png";
  const src = encoding === "base64"
    ? `data:${ct};base64,${body}`
    : `data:${ct};utf8,${encodeURIComponent(body)}`;
  return (
    <div className="p-4 grid place-items-center">
      <img src={src} alt="response" className="max-w-full max-h-[70vh] rounded shadow-lg" />
    </div>
  );
}
