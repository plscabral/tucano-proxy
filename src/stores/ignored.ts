import { create } from "zustand";
import type { Flow } from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { matchesCategory, type Category } from "@/lib/category";

// Persistent ignore-list. Anything matching is dropped from storage as soon
// as it arrives (same pipeline as captureMode) so noisy traffic from
// background apps (JetBrains, Claude, telemetry, ...) never pollutes the
// list. Two independent keys: clientApp name and host. Wildcard match is
// intentionally kept out — keep this dumb and predictable; rules engine
// already covers richer patterns via captureMode.
//
// Ignoring a HOST also adds it to the proxy's SSL skip-list (tunnel, never
// MITM): hiding a flow only removes it after it was already decrypted, which
// doesn't stop the interception that breaks cert-pinned clients. Adding the
// host to skip_hosts is what actually makes Tucano leave that host alone.
// (Ignoring an app has no host to skip, so it stays display-only.)

const KEY_APPS = "tucano:ignored:apps";
const KEY_HOSTS = "tucano:ignored:hosts";
const KEY_TYPES = "tucano:ignored:types";

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

type IgnoredState = {
  apps: Set<string>;
  hosts: Set<string>;
  types: Set<string>;
  addApp: (name: string) => void;
  removeApp: (name: string) => void;
  addHost: (host: string) => void;
  removeHost: (host: string) => void;
  addType: (id: string) => void;
  removeType: (id: string) => void;
  clear: () => void;
  matches: (f: Flow) => boolean;
};

export const useIgnored = create<IgnoredState>((set, get) => ({
  apps: loadSet(KEY_APPS),
  hosts: loadSet(KEY_HOSTS),
  types: loadSet(KEY_TYPES),

  addType(id) {
    if (!id) return;
    const next = new Set(get().types); next.add(id);
    set({ types: next }); saveSet(KEY_TYPES, next);
  },
  removeType(id) {
    const next = new Set(get().types); next.delete(id);
    set({ types: next }); saveSet(KEY_TYPES, next);
  },

  addApp(name) {
    if (!name) return;
    const next = new Set(get().apps); next.add(name);
    set({ apps: next }); saveSet(KEY_APPS, next);
  },
  removeApp(name) {
    const next = new Set(get().apps); next.delete(name);
    set({ apps: next }); saveSet(KEY_APPS, next);
  },
  addHost(host) {
    if (!host) return;
    const next = new Set(get().hosts); next.add(host);
    set({ hosts: next }); saveSet(KEY_HOSTS, next);
    void syncSkipHost(host, true);
  },
  removeHost(host) {
    const next = new Set(get().hosts); next.delete(host);
    set({ hosts: next }); saveSet(KEY_HOSTS, next);
    void syncSkipHost(host, false);
  },
  clear() {
    const removedHosts = [...get().hosts];
    const apps = new Set<string>();
    const hosts = new Set<string>();
    const types = new Set<string>();
    set({ apps, hosts, types });
    saveSet(KEY_APPS, apps);
    saveSet(KEY_HOSTS, hosts);
    saveSet(KEY_TYPES, types);
    void syncSkipHostsRemove(removedHosts);
  },

  matches(f) {
    const a = f.clientApp ?? "";
    if (a && get().apps.has(a)) return true;
    if (f.host && get().hosts.has(f.host)) return true;
    const types = get().types;
    if (types.size > 0) {
      for (const ty of types) if (matchesCategory(f, ty as Category)) return true;
    }
    return false;
  },
}));
