import { lazy, Suspense, useEffect, useState } from "react";
import { connect, isDesktop, takeFragmentToken, useConnection } from "@/lib/platform";
import logo from "@/assets/tucano-proxy.png";

// Store modules read persisted preferences at initialization. Load the app only
// after authenticated runtime discovery supplies the session namespace.
const App = lazy(() => import("@/App"));
const initialToken = isDesktop ? undefined : takeFragmentToken();

export default function PlatformGate() {
  const connection = useConnection();
  const [ready, setReady] = useState(isDesktop);
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!isDesktop) void connect(initialToken).then(() => setReady(true)).catch(() => {});
  }, []);
  if (ready) return <Suspense fallback={<div className="p-6" role="status">Loading Tucano Proxy…</div>}><App /></Suspense>;
  return (
    <main className="h-full grid place-items-center bg-[var(--tcn-canvas)] text-ink-500 dark:text-ink-50 p-6">
      <form className="w-full max-w-md flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        const credential = token.trim(); setToken("");
        void connect(credential || undefined).then(() => setReady(true)).catch(() => {});
      }}>
        <img src={logo} alt="" className="size-12" />
        <h1 className="text-2xl font-bold">Connect to Tucano Proxy</h1>
        <p className="text-sm opacity-75">Open the link from <code>tucano-proxy web --open</code>, or enter a service access token. Your token is exchanged for a private session cookie and is not stored in browser preferences.</p>
        <label className="text-sm font-semibold" htmlFor="service-token">Access token</label>
        <input id="service-token" type="password" autoComplete="off" autoFocus value={token} onChange={(e) => setToken(e.target.value)} className="rounded-lg border border-ink-100 bg-transparent p-3 text-sm" placeholder="Admin or read-only token" />
        {connection.error && <p role="alert" className="text-sm text-red-500">{connection.error}</p>}
        <button type="submit" disabled={connection.state === "connecting"} className="rounded-lg bg-toucan-400 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
          {connection.state === "connecting" ? "Connecting…" : "Connect"}
        </button>
        <p className="text-xs opacity-60">This browser controls only the session at {location.origin}. Capture does not change your operating system proxy settings.</p>
      </form>
    </main>
  );
}

export function ConnectionBanner({ port, running, systemProxyOn }: { port: number; running: boolean; systemProxyOn: boolean }) {
  const connection = useConnection();
  const [token, setToken] = useState("");
  if (isDesktop) return null;
  const online = connection.state === "connected";
  return (
    <div role="status" className={`flex items-center flex-wrap gap-3 px-[18px] py-2 text-xs border-b border-ink-100 dark:border-ink-400/40 ${online ? "" : "bg-red-500/10"}`}>
      <span className="font-semibold">Session: {connection.runtime?.session ?? "unknown"}</span>
      {online && connection.runtime?.scope === "read" && <span>Read-only access</span>}
      <span>{online ? running ? `Proxy: 127.0.0.1:${port}` : "Capture stopped" : connection.error ?? "Connecting…"}</span>
      {online && <span className="opacity-60">{systemProxyOn ? "This session is managing the system proxy." : "Configure your client proxy explicitly. This session is not managing the system proxy."}</span>}
      {!online && <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const credential = token.trim(); setToken(""); void connect(credential || undefined).catch(() => {}); }}>
        {connection.state === "unauthorized" && <input aria-label="New access token" type="password" autoComplete="off" placeholder="Access token" value={token} onChange={(e) => setToken(e.target.value)} className="rounded border border-ink-100 bg-transparent px-2 py-1" />}
        <button disabled={connection.state === "connecting"} className="underline disabled:opacity-50">Reconnect</button>
      </form>}
    </div>
  );
}
