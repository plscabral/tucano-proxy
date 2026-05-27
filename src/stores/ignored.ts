import { createSignal } from "solid-js";
import type { Flow } from "../lib/types";
import { ipc } from "../lib/ipc";

// Persistent ignore-list. Anything matching is dropped from storage as soon
// as it arrives (same pipeline as captureMode) so noisy traffic from
// background apps (JetBrains, Claude, telemetry, ...) never pollutes the
// list. Two independent keys: clientApp name and host. Wildcard match is
// intentional kept out — keep this dumb and predictable; rules engine
// already covers richer patterns via captureMode.
//
// Ignoring a HOST also adds it to the proxy's SSL skip-list (tunnel, never
// MITM): hiding a flow only removes it after it was already decrypted, which
// doesn't stop the interception that breaks cert-pinned clients. Adding the
// host to skip_hosts is what actually makes Tucano leave that host alone.
// (Ignoring an app has no host to skip, so it stays display-only.)

const KEY_APPS = "tucano:ignored:apps";
const KEY_HOSTS = "tucano:ignored:hosts";

// Keep the SSL skip-list in sync with the ignored-hosts set. Best-effort and
// additive: we only touch the given host, never other (manual) skip entries.
async function syncSkipHost(host: string, skip: boolean) {
  if (!host) return;
  try {
    const s = await ipc.getSslSettings();
    const set = new Set(s.skipHosts ?? []);
    if (skip) set.add(host); else set.delete(host);
    await ipc.setSslSettings({ mode: s.mode, hosts: s.hosts ?? [], skipHosts: [...set] });
  } catch {}
}

async function syncSkipHostsRemove(removed: string[]) {
  if (removed.length === 0) return;
  try {
    const s = await ipc.getSslSettings();
    const set = new Set(s.skipHosts ?? []);
    for (const h of removed) set.delete(h);
    await ipc.setSslSettings({ mode: s.mode, hosts: s.hosts ?? [], skipHosts: [...set] });
  } catch {}
}

function loadSet(key: string): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch { return new Set(); }
}
function saveSet(key: string, s: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...s])); } catch {}
}

const [apps, setApps] = createSignal<Set<string>>(loadSet(KEY_APPS));
const [hosts, setHosts] = createSignal<Set<string>>(loadSet(KEY_HOSTS));

function mutate(get: () => Set<string>, set: (v: Set<string>) => void, key: string, fn: (s: Set<string>) => void) {
  const next = new Set(get());
  fn(next);
  set(next);
  saveSet(key, next);
}

export const ignoredStore = {
  apps,
  hosts,

  addApp(name: string) {
    if (!name) return;
    mutate(apps, setApps, KEY_APPS, (s) => s.add(name));
  },
  removeApp(name: string) {
    mutate(apps, setApps, KEY_APPS, (s) => s.delete(name));
  },
  addHost(host: string) {
    if (!host) return;
    mutate(hosts, setHosts, KEY_HOSTS, (s) => s.add(host));
    void syncSkipHost(host, true);
  },
  removeHost(host: string) {
    mutate(hosts, setHosts, KEY_HOSTS, (s) => s.delete(host));
    void syncSkipHost(host, false);
  },
  clear() {
    const removedHosts = [...hosts()];
    mutate(apps, setApps, KEY_APPS, (s) => s.clear());
    mutate(hosts, setHosts, KEY_HOSTS, (s) => s.clear());
    void syncSkipHostsRemove(removedHosts);
  },

  matches(f: Flow): boolean {
    const a = f.clientApp ?? "";
    if (a && apps().has(a)) return true;
    if (f.host && hosts().has(f.host)) return true;
    return false;
  },
};
