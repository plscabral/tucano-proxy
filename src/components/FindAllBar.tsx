import { useFindAll } from "@/stores/findAll";
export default function FindAllBar() {
  const open = useFindAll((s) => s.open);
  if (!open) return null;
  return <div className="h-9 grid place-items-center text-xs text-muted-foreground border-b border-border/60 mono opacity-60">⟶ FindAllBar (migrando…)</div>;
}
