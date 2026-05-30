import type { Flow } from "@/lib/types";
import { Stub } from "./_stub";
export default function Inspector(_props: { flow: Flow | null; onClose: () => void; onComposer: (f?: Flow | null) => void }) {
  return <Stub name="Inspector" className="h-full" />;
}
