import { invoke, listen, isDesktop, saveSession, openSession, writeTextFile, writeBinaryFile, quitApp } from "./platform";
import type { UnlistenFn } from "./platform";
import type { Flow, ProxyStatus } from "./types";

export type SslSettings = {
  mode: "all" | "allowlist" | "blocklist";
  hosts: string[];
  skipHosts: string[];
  skipApps: string[];
  insecureHosts: string[];
};

export const ipc = {
  status: () => invoke<ProxyStatus>("get_status"),
  startProxy: (port: number) => invoke<void>("start_proxy", { port }),
  stopProxy: () => invoke<void>("stop_proxy"),
  startCapture: (port: number) => invoke<void>(isDesktop ? "start_capture" : "start_proxy", { port }),
  stopCapture: () => invoke<void>(isDesktop ? "stop_capture" : "stop_proxy"),
  installCa: () => invoke<void>("install_ca"),
  uninstallCa: () => invoke<void>("uninstall_ca"),
  exportCa: () => invoke<string>("export_ca"),
  toggleSystemProxy: (on: boolean) => invoke<void>("toggle_system_proxy", { on }),
  getPrivateMode: () => invoke<boolean>("get_private_mode"),
  setPrivateMode: (enabled: boolean) => invoke<void>("set_private_mode", { enabled }),
  clearFlows: () => invoke<void>("clear_flows"),
  deleteFlows: (ids: string[]) => invoke<void>("delete_flows", { ids }),
  restoreFlows: (flows: Flow[]) => invoke<void>("restore_flows", { flows }),
  listFlows: () => invoke<Flow[]>("list_flows"),
  getFlow: (id: string) => invoke<Flow>("get_flow", { id }),
  updateFlowNote: (id: string, note: string | null) => invoke<void>("update_flow_note", { id, note }),
  updateFlowMark: (id: string, mark: string | null) => invoke<void>("update_flow_mark", { id, mark }),
  replay: (id: string, headers: [string, string][], body: string | null) =>
    invoke<string>("replay_flow", { id, headers, body }),
  composeRequest: (args: {
    method: string; url: string;
    headers: [string, string][]; body: string | null; log: boolean;
  }) => invoke<Flow>("compose_request", args),
  saveSession,
  openSession,
  writeTextFile,
  writeBinaryFile,
  quitApp,
  getSslSettings: () =>
    invoke<SslSettings>("get_ssl_settings"),
  setSslSettings: (settings: SslSettings) =>
    invoke<void>("set_ssl_settings", { settings }),
  getKeepLimit: () => invoke<number>("get_keep_limit"),
  setKeepLimit: (limit: number) => invoke<void>("set_keep_limit", { limit }),
  getMcpSettings: () => invoke<McpSettings>("get_mcp_settings"),
  setMcpSettings: (settings: McpSettings) => invoke<void>("set_mcp_settings", { settings }),
  rotateMcpToken: () => invoke<McpSettings>("rotate_mcp_token"),
  listMcpClients: () => invoke<McpClientStatus[]>("list_mcp_clients"),
  mcpBinaryPath: () => invoke<string>("mcp_binary_path"),
  installMcpClient: (client: McpClient) =>
    invoke<McpClientStatus[]>("install_mcp_client", { client }),
  uninstallMcpClient: (client: McpClient) =>
    invoke<McpClientStatus[]>("uninstall_mcp_client", { client }),
};

export type McpClient = "claudeDesktop" | "claudeCode" | "codexDesktop" | "codex" | "opencode" | "opencodeDesktop" | "grok" | "gemini" | "pi" | "antigravity" | "ohMyPi";
export type McpClientStatus = {
  id: McpClient;
  label: string;
  path: string;
  installed: boolean;
};
export type McpTransport = "http" | "stdio";
export type McpSettings = {
  enabled: boolean;
  port: number;
  token: string;
  transport: McpTransport;
  autolaunch: boolean;
};

export const onFlowNew = (cb: (f: Flow) => void): Promise<UnlistenFn> =>
  listen<Flow>("flow:new", (e) => cb(e.payload));
export const onFlowUpdate = (cb: (f: Flow) => void): Promise<UnlistenFn> =>
  listen<Flow>("flow:update", (e) => cb(e.payload));
export const onFlowsTrimmed = (cb: (ids: string[]) => void): Promise<UnlistenFn> =>
  listen<string[]>("flows:trimmed", (e) => cb(e.payload));
