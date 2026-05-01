import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Flow, ProxyStatus } from "./types";

export const ipc = {
  status: () => invoke<ProxyStatus>("get_status"),
  startProxy: (port: number) => invoke<void>("start_proxy", { port }),
  stopProxy: () => invoke<void>("stop_proxy"),
  startCapture: (port: number) => invoke<void>("start_capture", { port }),
  stopCapture: () => invoke<void>("stop_capture"),
  installCa: () => invoke<void>("install_ca"),
  uninstallCa: () => invoke<void>("uninstall_ca"),
  exportCa: () => invoke<string>("export_ca"),
  toggleSystemProxy: (on: boolean) => invoke<void>("toggle_system_proxy", { on }),
  clearFlows: () => invoke<void>("clear_flows"),
  deleteFlows: (ids: string[]) => invoke<void>("delete_flows", { ids }),
  restoreFlows: (flows: Flow[]) => invoke<void>("restore_flows", { flows }),
  listFlows: () => invoke<Flow[]>("list_flows"),
  getFlow: (id: string) => invoke<Flow>("get_flow", { id }),
  updateFlowNote: (id: string, note: string | null) => invoke<void>("update_flow_note", { id, note }),
  replay: (id: string, headers: [string, string][], body: string | null) =>
    invoke<string>("replay_flow", { id, headers, body }),
  saveSession: (path: string, ids?: string[]) =>
    invoke<void>("save_session", { path, ids: ids ?? null }),
  openSession: (path: string) => invoke<void>("open_session", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  writeBinaryFile: (path: string, contentsBase64: string) => invoke<void>("write_binary_file", { path, contentsBase64 }),
  quitApp: () => invoke<void>("quit_app"),
  getSslSettings: () => invoke<{ mode: "all" | "allowlist" | "blocklist"; hosts: string[] }>("get_ssl_settings"),
  setSslSettings: (settings: { mode: "all" | "allowlist" | "blocklist"; hosts: string[] }) =>
    invoke<void>("set_ssl_settings", { settings }),
};

export const onFlowNew = (cb: (f: Flow) => void): Promise<UnlistenFn> =>
  listen<Flow>("flow:new", (e) => cb(e.payload));
export const onFlowUpdate = (cb: (f: Flow) => void): Promise<UnlistenFn> =>
  listen<Flow>("flow:update", (e) => cb(e.payload));
