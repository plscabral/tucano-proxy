export type Flow = {
  id: string;
  index: number;
  startedAt: number;
  endedAt: number | null;
  method: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  httpVersion: string;
  status: number | null;
  statusText: string | null;
  reqHeaders: [string, string][];
  reqBody: string | null;
  reqBodyEncoding: "utf8" | "base64";
  reqContentType: string | null;
  reqSize: number;
  resHeaders: [string, string][];
  resBody: string | null;
  resBodyEncoding: "utf8" | "base64";
  resContentType: string | null;
  resSize: number;
  durationMs: number | null;
  error: string | null;
  clientApp: string | null;
  clientPort: number | null;
  clientIcon: string | null;
  note?: string | null;
};

export type ProxyStatus = {
  running: boolean;
  port: number;
  caInstalled: boolean;
  systemProxyOn: boolean;
  flowsCount: number;
};
