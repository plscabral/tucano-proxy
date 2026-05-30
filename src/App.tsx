import { Display, Accent } from "./components/Display";

// TEMPORARY smoke-test shell — validates the React + Vite + Tailwind + shadcn
// token pipeline and the new type pairing. Replaced by the real app in Phase 3.
export default function App() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-8 bg-background text-foreground">
      <Display className="text-6xl text-center">
        Tecnologia que ajuda
        <br />
        pessoas a <Accent>crescerem</Accent>
      </Display>
      <div className="flex items-center gap-3">
        <button className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">
          Primary (toucan)
        </button>
        <span className="rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
          muted on card
        </span>
        <span className="mono rounded bg-accent px-2 py-1 text-xs text-accent-foreground">
          200 OK
        </span>
      </div>
    </div>
  );
}
