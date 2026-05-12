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

function decodeBody(body, encoding) {
  if (body == null) return null;
  if (encoding === "base64") {
    return { encoding: "base64", base64: body, note: "binary payload, base64-encoded" };
  }
  return { encoding: "utf8", text: body };
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
      "List captured HTTP flows (newest last). Returns summaries without bodies. Use tucano_get_flow / tucano_get_response_body to drill in.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max flows to return (newest kept)." },
        host: { type: "string", description: "Substring match on host." },
        method: { type: "string", description: "HTTP method (GET, POST, ...)." },
        status: { type: "integer", description: "Exact response status code." },
        q: { type: "string", description: "Free-text match against host/path/method." },
        since: { type: "integer", description: "Only flows started at or after this epoch-millis timestamp. Use for incremental polling during automations (call repeatedly with the timestamp of the last seen flow)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_flow",
    description: "Get a single flow's full record, including request and response bodies.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_request_body",
    description: "Get just the request body of a flow (decoded; base64 if binary).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_get_response_body",
    description: "Get just the response body of a flow (decoded; base64 if binary).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "tucano_replay_flow",
    description: "Replay an existing flow, optionally overriding headers and/or body. Creates a new flow.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        headers: {
          type: "array",
          description: "Optional header overrides as [name, value] tuples. Replaces ALL original headers when provided.",
          items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
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
];

const server = new Server(
  { name: "tucano-mcp", version: "0.1.0" },
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
      return await tucano(`/flows/${encodeURIComponent(args.id)}`);
    case "tucano_get_request_body": {
      const f = await tucano(`/flows/${encodeURIComponent(args.id)}`);
      return decodeBody(f.reqBody, f.reqBodyEncoding);
    }
    case "tucano_get_response_body": {
      const f = await tucano(`/flows/${encodeURIComponent(args.id)}`);
      return decodeBody(f.resBody, f.resBodyEncoding);
    }
    case "tucano_replay_flow":
      return await tucano(`/flows/${encodeURIComponent(args.id)}/replay`, {
        method: "POST",
        body: JSON.stringify({ headers: args.headers, body: args.body }),
      });
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

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`tucano-mcp: connected (TUCANO_URL=${BASE_URL})\n`);
