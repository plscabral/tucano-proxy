// Shared placeholder used by not-yet-ported panels during the React migration.
// Each real component replaces its stub in its migration phase.
export function Stub({ name, className }: { name: string; className?: string }) {
  return (
    <div className={`grid place-items-center text-xs text-muted-foreground select-none ${className ?? ""}`}>
      <span className="mono opacity-60">⟶ {name} (migrando…)</span>
    </div>
  );
}
