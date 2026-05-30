import { useSidebar } from "@/stores/sidebar";
import { Stub } from "./_stub";
export default function Sidebar() {
  const width = useSidebar((s) => s.width);
  return <div style={{ width }} className="shrink-0 border-r border-border/60"><Stub name="Sidebar" className="h-full" /></div>;
}
