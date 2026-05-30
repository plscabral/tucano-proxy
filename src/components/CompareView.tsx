import type { Flow } from "@/lib/types";
export default function CompareView({ onClose }: { a: Flow; b: Flow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center text-sm mono text-muted-foreground" onClick={onClose}>
      ⟶ CompareView (migrando…)
    </div>
  );
}
