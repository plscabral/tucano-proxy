import { createSignal } from "solid-js";
import type { Flow } from "../lib/types";

// Persistent ignore-list. Anything matching is dropped from storage as soon
// as it arrives (same pipeline as captureMode) so noisy traffic from
// background apps (JetBrains, Claude, telemetry, ...) never pollutes the
// list. Two independent keys: clientApp name and host. Wildcard match is
// intentional kept out — keep this dumb and predictable; rules engine
// already covers richer patterns via captureMode.

const KEY_APPS = "tucano:ignored:apps";
const KEY_HOSTS = "tucano:ignored:hosts";

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
  },
  removeHost(host: string) {
    mutate(hosts, setHosts, KEY_HOSTS, (s) => s.delete(host));
  },
  clear() {
    mutate(apps, setApps, KEY_APPS, (s) => s.clear());
    mutate(hosts, setHosts, KEY_HOSTS, (s) => s.clear());
  },

  matches(f: Flow): boolean {
    const a = f.clientApp ?? "";
    if (a && apps().has(a)) return true;
    if (f.host && hosts().has(f.host)) return true;
    return false;
  },
};
