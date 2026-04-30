export default function ImageViewer(props: {
  body: string;
  encoding: "utf8" | "base64";
  contentType: string | null;
}) {
  const ct = props.contentType ?? "image/png";
  const src = props.encoding === "base64"
    ? `data:${ct};base64,${props.body}`
    : `data:${ct};utf8,${encodeURIComponent(props.body)}`;
  return (
    <div class="p-4 grid place-items-center">
      <img src={src} alt="response" class="max-w-full max-h-[70vh] rounded shadow-lg" />
    </div>
  );
}
