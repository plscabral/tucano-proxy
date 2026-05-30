#!/usr/bin/env node
// Tucano MCP — bridges the local Tucano Proxy HTTP API to MCP stdio clients.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.TUCANO_URL || "http://127.0.0.1:7878").replace(/\/$/, "");
const TOKEN = process.env.TUCANO_TOKEN || "";

if (!TOKEN) {
  process.stderr.write(
    "tucano-mcp: TUCANO_TOKEN env var is required. Copy it from Tucano > Settings > MCP.\n",
  );
  process.exit(1);
}

async function tucano(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tucano ${res.status}: ${text || res.statusText}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Build a `?a=b&c=d` query string from defined (non-empty) values.
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v != null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Tokenize a dot/bracket path: "data.items[0].name" / "a.b[*].c"
function tokenizePath(path) {
  const tokens = [];
  const re = /[^.[\]]+|\[\d+\]|\[\*\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    const t = m[0];
    if (t.startsWith("[")) {
      const inner = t.slice(1, -1);
      tokens.push(inner === "*" ? { star: true } : { index: Number(inner) });
    } else {
      tokens.push({ key: t });
    }
  }
  return tokens;
}

function evalPath(value, tokens) {
  let cur = [value];
  for (const tk of tokens) {
    const next = [];
    for (const v of cur) {
      if (v == null) continue;
      if (tk.star) { if (Array.isArray(v)) next.push(...v); }
      else if (tk.index != null) { if (Array.isArray(v)) next.push(v[tk.index]); }
      else { next.push(v[tk.key]); }
    }
    cur = next;
  }
  return cur;
}

// Fetch a body (req/res), optionally extracting a JSON sub-value via `select`.
async function getBody(args, which) {
  if (!args.select) {
    return await tucano(`/flows/${encodeURIComponent(args.id)}/${which}${qs({ maxBytes: args.maxBytes, offset: args.offset })}`);
  }
  // select needs the whole JSON — pull it in full, then extract just the slice.
  const r = await tucano(`/flows/${encodeURIComponent(args.id)}/${which}${qs({ maxBytes: 50_000_000 })}`);
  if (!r || r.empty) return { select: args.select, value: null, note: "empty body" };
  if (r.encoding !== "utf8") return { select: args.select, error: "body is binary — cannot JSON-select" };
  let json;
  try { json = JSON.parse(r.text); }
  catch { return { select: args.select, error: "body is not valid JSON" }; }
  const tokens = tokenizePath(args.select);
  const hasStar = tokens.some((t) => t.star);
  const res = evalPath(json, tokens);
  return { select: args.select, totalBytes: r.totalBytes, value: hasStar ? res : res[0] };
}

// Strip bodies + heavy fields so list responses fit in LLM context.
function summarizeFlow(f) {
  return {
    id: f.id,
    index: f.index,
    method: f.method,
    url: `${f.scheme}://${f.host}${f.port && f.port !== 80 && f.port !== 443 ? `:${f.port}` : ""}${f.path}`,
    status: f.status,
    statusText: f.statusText,
    durationMs: f.durationMs,
    reqSize: f.reqSize,
    resSize: f.resSize,
    reqContentType: f.reqContentType,
    resContentType: f.resContentType,
    clientApp: f.clientApp,
    note: f.note,
    error: f.error,
  };
}

const TOOLS = [
  {
    name: "tucano_status",
    description: "Get current Tucano Proxy status (running, port, captured flow count).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tucano_list_flows",
    description:
      "List captured HTTP flows (newest last). Returns summaries WITHOUT bodies. To search inside bodies/headers use tucano_search; to read a body use tucano_get_response_body. Combine filters to keep results (and tokens) small.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max flows to return (newest kept). Omit = all matches." },
        offset: { type: "integer", minimum: 0, description: "Skip this many of the newest matches (for paging back through history)." },
        host: { type: "string", description: "Substring match on host." },
        method: { type: "string", description: "HTTP method (GET, POST, ...)." },
        status: { type: "integer", description: "Exact response status code." },
        statusClass: { type: "string", enum: ["1xx", "2xx", "3xx", "4xx", "5xx"], description: "Match a whole status class, e.g. '5xx' for all server errors." },
        statusMin: { type: "integer", description: "Minimum status code (inclusive)." },
        statusMax: { type: "integer", description: "Maximum status code (inclusive)." },
        contentType: { type: "string", description: "Substring match on request or response Content-Type, e.g. 'json'." },
        path: { type: "string", description: "Substring match on the request path." },
        clientApp: { type: "string", description: "Substring match on the originating client app." },
        minDurationMs: { type: "integer", description: "Only flows that took at least this long (ms) — find slow calls." },
        minSize: { type: "integer", description: "Only flows whose request or response is at least this many bytes." },
        q: { type: "string", description: "Free-text match against host/path/method ONLY (not bodies — use tucano_search for that)." },
        since: { type: "integer", description: "Only flows started at or after this epoch-millis timestamp. Use for incremental polling during automations." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_flow",
    description: "Get a single flow's full record. Bodies are included by default — pass includeBodies:false to get only metadata + headers (cheaper) when you don't need the payload.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeBodies: { type: "boolean", default: true, description: "Set false to omit request/response bodies (metadata + headers only)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_request_body",
    description: "Get just the request body of a flow. Returns at most maxBytes (default 64KB) starting at offset, with totalBytes + truncated so you can page large payloads instead of pulling them whole.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, description: "Max bytes to return (default 65536). Keep small to save tokens." },
        offset: { type: "integer", minimum: 0, description: "Byte offset to start from (for paging)." },
        select: { type: "string", description: "Extract a sub-value from a JSON body instead of returning the whole thing. Dot/bracket path, e.g. 'data.items[0].id' or 'data.items[*].name' ([*] fans out over an array). Huge token saver." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_response_body",
    description: "Get just the response body of a flow. Returns at most maxBytes (default 64KB) starting at offset, with totalBytes + truncated so you can page large payloads instead of pulling them whole.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, description: "Max bytes to return (default 65536). Keep small to save tokens." },
        offset: { type: "integer", minimum: 0, description: "Byte offset to start from (for paging)." },
        select: { type: "string", description: "Extract a sub-value from a JSON body instead of returning the whole thing. Dot/bracket path, e.g. 'data.items[0].id' or 'data.items[*].name' ([*] fans out over an array). Huge token saver." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_replay_flow",
    description: "Replay an existing flow, creating a new one. You can tweak just one header with setHeaders/removeHeaders (no need to fetch and resend the whole header list).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        headers: {
          type: "array",
          description: "FULL header replacement as [name, value] tuples. Replaces ALL original headers. Prefer setHeaders/removeHeaders for small edits.",
          items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        },
        setHeaders: {
          type: "array",
          description: "Override/add specific headers (case-insensitive by name); other original headers are kept.",
          items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        },
        removeHeaders: {
          type: "array",
          description: "Remove these header names (case-insensitive); other original headers are kept.",
          items: { type: "string" },
        },
        body: { type: "string", description: "Optional body override (utf8 or base64 — depends on content)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_compose_request",
    description: "Send a brand-new HTTP request through Tucano. Returns the resulting flow.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        url: { type: "string", description: "Full URL including scheme." },
        headers: {
          type: "array",
          items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        },
        body: { type: "string" },
        log: { type: "boolean", default: true, description: "If false, the flow is sent but not persisted to the captures list." },
      },
      required: ["method", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_delete_flows",
    description: "Delete flows by id.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_clear_flows",
    description: "Wipe ALL captured flows. Use at the start of an automation to establish a clean baseline.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tucano_start_capture",
    description: "Turn on the local proxy AND flip the OS proxy so traffic actually reaches Tucano.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "integer", description: "Proxy port. Defaults to current Tucano setting (usually 8888)." } },
      additionalProperties: false,
    },
  },
  {
    name: "tucano_stop_capture",
    description: "Turn off the OS proxy and stop the local proxy server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tucano_export_as_curl",
    description: "Render one or more flows as ready-to-run curl commands. Useful for handing the captured traffic to a developer or to Claude Code to reimplement.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        includeHeaders: { type: "boolean", default: true, description: "Include request headers (cookies, auth, etc)." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_export_as_code",
    description: "Render one or more flows as code snippets in the chosen language/library.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        lang: { type: "string", enum: ["fetch", "axios", "python"], default: "fetch", description: "fetch (browser/Node), axios, or python (requests)." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_search",
    description:
      "Full-text search INSIDE captured request/response bodies and headers (server-side). Returns matching flow ids + short snippets — far cheaper than downloading bodies to grep them yourself. Binary bodies are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Text to search for." },
        scope: { type: "string", enum: ["all", "body", "headers"], default: "all", description: "Where to look." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max matching flows to return (default 50)." },
        ignoreCase: { type: "boolean", default: true, description: "Case-insensitive match." },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_stats",
    description:
      "Aggregate stats over ALL captured flows: counts by status class / method / host / content-type, total bytes, error count, slowest and largest flows, time range. Use this instead of listing everything and counting in-context.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tucano_wait_for",
    description:
      "Block until a flow matching the given filters is captured (or timeout). One cheap call instead of busy-polling tucano_list_flows. Trigger an action in the app, then wait for the resulting request here.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Substring match on host." },
        path: { type: "string", description: "Substring match on path." },
        method: { type: "string", description: "HTTP method." },
        status: { type: "integer", description: "Exact response status." },
        since: { type: "integer", description: "Only match flows at/after this epoch-ms. Defaults to call time (only new traffic)." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60000, description: "Max wait in ms (default 15000, cap 60000)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tucano_diff",
    description:
      "Structured diff of two flows: changed request line / status / duration, and headers added / removed / changed, plus whether each body is identical. Cheaper than fetching both flows and diffing in-context.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "string", description: "First flow id." }, b: { type: "string", description: "Second flow id." } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_ssl_settings",
    description: "Get the current SSL-proxying settings (which HTTPS hosts get decrypted so their bodies are captured).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tucano_set_ssl_settings",
    description:
      "Configure SSL proxying so HTTPS bodies for the hosts you care about are actually decrypted/captured. If a host isn't covered, its flows are tunneled (no body). Applies immediately to new traffic.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "allowlist", "blocklist"], description: "all = decrypt everything; allowlist = only `hosts`; blocklist = everything except `hosts`." },
        hosts: { type: "array", items: { type: "string" }, description: "Host patterns: exact, *.example.com, api.foo.*" },
        skipHosts: { type: "array", items: { type: "string" }, description: "Hosts to always tunnel (never decrypt), regardless of mode." },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_export_as_har",
    description: "Export one or more flows as a standard HAR 1.2 log (importable into browsers, Postman, etc).",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "tucano-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const result = await dispatch(name, args);
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `tucano-mcp error: ${e?.message || String(e)}` }],
    };
  }
});

async function dispatch(name, args) {
  switch (name) {
    case "tucano_status":
      return await tucano("/status");
    case "tucano_list_flows": {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (v != null && v !== "") params.set(k, String(v));
      }
      const qs = params.toString();
      const flows = await tucano(`/flows${qs ? `?${qs}` : ""}`);
      return (flows || []).map(summarizeFlow);
    }
    case "tucano_get_flow":
      return await tucano(`/flows/${encodeURIComponent(args.id)}${qs({ includeBodies: args.includeBodies })}`);
    case "tucano_get_request_body":
      return await getBody(args, "req_body");
    case "tucano_get_response_body":
      return await getBody(args, "res_body");
    case "tucano_replay_flow":
      return await tucano(`/flows/${encodeURIComponent(args.id)}/replay`, {
        method: "POST",
        body: JSON.stringify({
          headers: args.headers,
          setHeaders: args.setHeaders,
          removeHeaders: args.removeHeaders,
          body: args.body,
        }),
      });
    case "tucano_search":
      return await tucano(`/search${qs({ q: args.q, scope: args.scope, limit: args.limit, ignoreCase: args.ignoreCase })}`);
    case "tucano_stats":
      return await tucano("/stats");
    case "tucano_wait_for":
      return await tucano(`/wait${qs({ host: args.host, path: args.path, method: args.method, status: args.status, since: args.since, timeoutMs: args.timeoutMs })}`);
    case "tucano_diff":
      return await tucano(`/diff${qs({ a: args.a, b: args.b })}`);
    case "tucano_get_ssl_settings":
      return await tucano("/ssl");
    case "tucano_set_ssl_settings":
      return await tucano("/ssl", {
        method: "POST",
        body: JSON.stringify({ mode: args.mode, hosts: args.hosts || [], skipHosts: args.skipHosts || [] }),
      });
    case "tucano_export_as_har": {
      const flows = await Promise.all(
        args.ids.map((id) => tucano(`/flows/${encodeURIComponent(id)}`)),
      );
      return flowToHar(flows);
    }
    case "tucano_compose_request":
      return await tucano("/compose", {
        method: "POST",
        body: JSON.stringify({
          method: args.method,
          url: args.url,
          headers: args.headers,
          body: args.body,
          log: args.log,
        }),
      });
    case "tucano_delete_flows":
      await tucano("/flows", { method: "DELETE", body: JSON.stringify({ ids: args.ids }) });
      return { deleted: args.ids.length };
    case "tucano_clear_flows":
      await tucano("/clear", { method: "POST" });
      return { cleared: true };
    case "tucano_start_capture":
      return await tucano("/capture/start", {
        method: "POST",
        body: JSON.stringify(args.port ? { port: args.port } : {}),
      });
    case "tucano_stop_capture":
      return await tucano("/capture/stop", { method: "POST" });
    case "tucano_export_as_curl": {
      const includeHeaders = args.includeHeaders !== false;
      const flows = await Promise.all(
        args.ids.map((id) => tucano(`/flows/${encodeURIComponent(id)}`)),
      );
      return flows.map((f) => ({ id: f.id, curl: flowToCurl(f, includeHeaders) }));
    }
    case "tucano_export_as_code": {
      const lang = args.lang || "fetch";
      const flows = await Promise.all(
        args.ids.map((id) => tucano(`/flows/${encodeURIComponent(id)}`)),
      );
      return flows.map((f) => ({ id: f.id, code: flowToCode(f, lang) }));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function flowUrl(f) {
  const defaultPort = (f.scheme === "https" && f.port === 443) || (f.scheme === "http" && f.port === 80);
  return `${f.scheme}://${f.host}${defaultPort ? "" : `:${f.port}`}${f.path}`;
}

function bodyAsText(f) {
  if (f.reqBody == null) return null;
  if (f.reqBodyEncoding === "base64") return null; // skip binary
  return f.reqBody;
}

function flowToCurl(f, includeHeaders) {
  const lines = [`curl -X ${f.method} ${shellQuote(flowUrl(f))}`];
  if (includeHeaders) {
    for (const [k, v] of f.reqHeaders || []) {
      if (/^(content-length|host)$/i.test(k)) continue;
      lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
    }
  }
  const body = bodyAsText(f);
  if (body) lines.push(`  --data-raw ${shellQuote(body)}`);
  return lines.join(" \\\n");
}

function flowToCode(f, lang) {
  const url = flowUrl(f);
  const headers = Object.fromEntries(
    (f.reqHeaders || []).filter(([k]) => !/^(content-length|host)$/i.test(k)),
  );
  const body = bodyAsText(f);
  if (lang === "axios") {
    return [
      `import axios from "axios";`,
      ``,
      `const res = await axios.request({`,
      `  method: ${JSON.stringify(f.method)},`,
      `  url: ${JSON.stringify(url)},`,
      `  headers: ${JSON.stringify(headers, null, 2)},`,
      body ? `  data: ${JSON.stringify(body)},` : null,
      `});`,
    ].filter(Boolean).join("\n");
  }
  if (lang === "python") {
    return [
      `import requests`,
      ``,
      `res = requests.request(`,
      `    method=${JSON.stringify(f.method)},`,
      `    url=${JSON.stringify(url)},`,
      `    headers=${JSON.stringify(headers, null, 4)},`,
      body ? `    data=${JSON.stringify(body)},` : null,
      `)`,
    ].filter(Boolean).join("\n");
  }
  // default: fetch
  return [
    `const res = await fetch(${JSON.stringify(url)}, {`,
    `  method: ${JSON.stringify(f.method)},`,
    `  headers: ${JSON.stringify(headers, null, 2)},`,
    body ? `  body: ${JSON.stringify(body)},` : null,
    `});`,
  ].filter(Boolean).join("\n");
}

function flowToHar(flows) {
  const entries = flows.filter(Boolean).map((f) => {
    const reqHeaders = (f.reqHeaders || []).map(([name, value]) => ({ name, value }));
    const resHeaders = (f.resHeaders || []).map(([name, value]) => ({ name, value }));
    const postData = f.reqBody != null
      ? {
          mimeType: f.reqContentType || "application/octet-stream",
          text: f.reqBody,
          ...(f.reqBodyEncoding === "base64" ? { encoding: "base64" } : {}),
        }
      : undefined;
    return {
      startedDateTime: new Date(f.startedAt || 0).toISOString(),
      time: f.durationMs ?? 0,
      request: {
        method: f.method,
        url: flowUrl(f),
        httpVersion: f.httpVersion || "HTTP/1.1",
        headers: reqHeaders,
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: f.reqSize ?? -1,
        ...(postData ? { postData } : {}),
      },
      response: {
        status: f.status ?? 0,
        statusText: f.statusText || "",
        httpVersion: f.httpVersion || "HTTP/1.1",
        headers: resHeaders,
        cookies: [],
        content: {
          size: f.resSize ?? -1,
          mimeType: f.resContentType || "",
          text: f.resBody == null ? "" : f.resBody,
          ...(f.resBodyEncoding === "base64" ? { encoding: "base64" } : {}),
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: f.resSize ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: f.durationMs ?? 0, receive: 0 },
    };
  });
  return { log: { version: "1.2", creator: { name: "Tucano Proxy", version: "0.2.0" }, entries } };
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`tucano-mcp: connected (TUCANO_URL=${BASE_URL})\n`);
