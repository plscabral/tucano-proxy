export default function Settings({ open }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center text-sm mono text-muted-foreground">⟶ Settings (migrando…)</div>;
}
