import { isTauri, invoke as nativeInvoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

// Native plugins are loaded only at the desktop boundary: the standalone
// browser has no native plugin runtime and must never initialize those APIs.

export const isDesktop = isTauri();
export type Runtime = { session: string; instanceId: string; scope: "admin" | "read"; proxyPort: number; endpoint: string; version: string };
type Connection = { state: "connecting" | "connected" | "disconnected" | "unauthorized" | "detached"; runtime: Runtime | null; error: string | null };
let connection: Connection = { state: isDesktop ? "connected" : "connecting", runtime: null, error: null };
const subscribers = new Set<() => void>();
export const getConnection = () => connection;
function updateConnection(patch: Partial<Connection>) {
  connection = { ...connection, ...patch };
  subscribers.forEach((cb) => cb());
}
export const useConnection = () => useSyncExternalStore((cb) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; }, getConnection);
export const canMutate = () => isDesktop || (connection.state === "connected" && connection.runtime?.scope === "admin");
export const preferenceStorage = {
  key: (key: string) => isDesktop ? key : `tucano:web:${connection.runtime?.session ?? "login"}:${key}`,
  getItem(key: string) { try { return localStorage.getItem(this.key(key)); } catch { return null; } },
  setItem(key: string, value: string) { try { localStorage.setItem(this.key(key), value); } catch { /* Storage can be disabled by browser policy. */ } },
  removeItem(key: string) { try { localStorage.removeItem(this.key(key)); } catch { /* Storage can be disabled by browser policy. */ } },
};

export async function serviceRequest(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(`/api/v1/${path}`, { ...init, credentials: "same-origin", cache: "no-store" }); }
  catch { updateConnection({ state: "disconnected", error: "Local service is unavailable. Start Tucano Proxy, then reconnect." }); throw new Error(connection.error!); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body?.error?.message ?? `Service request failed (${response.status}).`;
    if (response.status === 401) updateConnection({ state: "unauthorized", error: message });
    throw new Error(message);
  }
  return response;
}
export async function connect(token?: string): Promise<void> {
  if (isDesktop) return;
  updateConnection({ state: "connecting", error: null });
  try {
    if (token) await serviceRequest("auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const response = await serviceRequest("runtime");
    const { result } = await response.json();
    const previous = connection.runtime;
    if (previous && previous.session !== result.session) { window.location.reload(); return; }
    updateConnection({ runtime: result, state: "connected", error: null });
    if (listeners.size && (!stream || stream.readyState === EventSource.CLOSED)) {
      stream?.close(); stream = null; openStream();
    }
    dispatchEvent(new Event("tucano:resync"));
  } catch (error) {
    if (connection.state === "connecting") updateConnection({ state: "disconnected", error: String(error) });
    throw error;
  }
}
export function takeFragmentToken(): string | undefined {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token") ?? undefined;
  if (token) history.replaceState(null, "", location.pathname + location.search);
  return token;
}
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return nativeInvoke<T>(command, args);
  const response = await serviceRequest("invoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, args }) });
  return (await response.json()).result as T;
}

export type UnlistenFn = () => void;
type CoreEvent = { sequence: number; event: string; payload: unknown };
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let stream: EventSource | null = null;
let sequence = 0;
function openStream() {
  if (stream || isDesktop) return;
  stream = new EventSource("/api/v1/events");
  stream.onopen = () => { void connect().catch(() => {}); };
  stream.onerror = () => {
    if (connection.state !== "unauthorized") updateConnection({ state: "disconnected", error: "Live connection lost. Reconnecting; displayed captures may be out of date." });
  };
  const receive = (message: MessageEvent<string>) => {
    try {
      const event = JSON.parse(message.data) as CoreEvent;
      if (event.event === "resync" || (sequence && event.sequence !== sequence + 1)) dispatchEvent(new Event("tucano:resync"));
      sequence = event.sequence ?? 0;
      listeners.get(event.event)?.forEach((cb) => cb(event.payload));
    } catch { dispatchEvent(new Event("tucano:resync")); }
  };
  stream.onmessage = receive;
  stream.addEventListener("resync", () => { sequence = 0; dispatchEvent(new Event("tucano:resync")); });
}
export async function listen<T>(event: string, cb: (event: { payload: T }) => void): Promise<UnlistenFn> {
  if (isDesktop) return (await import("@tauri-apps/api/event")).listen<T>(event, cb);
  const handler = (payload: unknown) => cb({ payload: payload as T });
  const group = listeners.get(event) ?? new Set();
  group.add(handler); listeners.set(event, group); openStream();
  return () => { group.delete(handler); if (!group.size) listeners.delete(event); if (!listeners.size) { stream?.close(); stream = null; sequence = 0; } };
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name.split(/[\\/]/).pop() || "tucano-export";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
type FileOptions = { defaultPath?: string; multiple?: boolean; filters?: { name: string; extensions: string[] }[] };
export async function save(options: FileOptions): Promise<string | null> {
  if (isDesktop) return (await import("@tauri-apps/plugin-dialog")).save(options);
  return options.defaultPath ?? "session.tucano";
}
export async function open(options: FileOptions): Promise<string | File | null> {
  if (isDesktop) return (await import("@tauri-apps/plugin-dialog")).open({ ...options, multiple: false });
  return new Promise((resolve) => {
    const input = document.createElement("input"); input.type = "file";
    input.accept = options.filters?.flatMap((f) => f.extensions.map((ext) => `.${ext}`)).join(",") ?? "";
    input.style.display = "none"; document.body.append(input);
    const finish = (file: File | null) => { input.remove(); resolve(file); };
    input.onchange = () => finish(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}
export async function confirm(message: string, options?: { title?: string; kind?: "warning" | "info" | "error"; okLabel?: string; cancelLabel?: string }): Promise<boolean> {
  if (isDesktop) return (await import("@tauri-apps/plugin-dialog")).confirm(message, options);
  return window.confirm(message);
}
export async function writeTextFile(path: string, contents: string) {
  if (isDesktop) return nativeInvoke<void>("write_text_file", { path, contents });
  downloadBlob(path, new Blob([contents], { type: "text/plain;charset=utf-8" }));
}
export async function writeBinaryFile(path: string, contentsBase64: string) {
  if (isDesktop) return nativeInvoke<void>("write_binary_file", { path, contentsBase64 });
  const binary = atob(contentsBase64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  downloadBlob(path, new Blob([bytes], { type: "application/octet-stream" }));
}
export async function saveSession(path: string, ids?: string[]) {
  if (ids?.length === 0) throw new Error("There are no captures in this selection to save.");
  if (isDesktop) return nativeInvoke<void>("save_session", { path, ids: ids ?? null });
  const query = ids ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
  downloadBlob(path, await (await serviceRequest(`session/export${query}`)).blob());
}
export async function openSession(file: string | File) {
  if (isDesktop) return nativeInvoke<void>("open_session", { path: file });
  if (!(file instanceof File)) throw new Error("Choose a local Tucano session file to upload. Server filesystem paths are not accepted.");
  await serviceRequest("session/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  dispatchEvent(new Event("tucano:resync"));
}
export const getVersion = async () => isDesktop ? (await import("@tauri-apps/api/app")).getVersion() : invoke<string>("get_version");
export async function nativeWindow() {
  if (!isDesktop) throw new Error("Window controls are available in the desktop app only.");
  return (await import("@tauri-apps/api/window")).getCurrentWindow();
}
export async function check(): Promise<Update | null> {
  if (!isDesktop) throw new Error("Update the Tucano Proxy service using your package manager or the latest release, then restart it.");
  return (await import("@tauri-apps/plugin-updater")).check();
}
export type { Update };
export async function relaunch() {
  if (!isDesktop) { location.reload(); return; }
  return (await import("@tauri-apps/plugin-process")).relaunch();
}
export async function quitApp() {
  if (isDesktop) return nativeInvoke<void>("quit_app");
  stream?.close(); stream = null;
  updateConnection({ state: "detached", error: "Disconnected from Tucano Proxy. The service and capture continue running." });
}
