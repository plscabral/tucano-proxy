# tucano-mcp

MCP server that exposes [Tucano Proxy](https://github.com/plscabral/tucano-proxy)'s captured HTTP/HTTPS flows to LLM clients (Claude Desktop, Claude Code, Cursor, etc).

It lets an agent **observe, search, replay and reshape** the traffic Tucano captures — and do it cheaply: list responses strip bodies, search/extraction happen server-side, and large payloads are paged instead of dumped into context.

## Requirements

- Tucano Proxy desktop app running with the MCP bridge enabled (Settings → MCP).
- Node.js ≥ 18.

## Install

The recommended way is `npx`, so the client picks up updates automatically:

```json
{
  "mcpServers": {
    "tucano": {
      "command": "npx",
      "args": ["-y", "tucano-mcp"],
      "env": {
        "TUCANO_TOKEN": "paste-the-token-from-tucano-settings"
      }
    }
  }
}
```

Override the bridge URL with `TUCANO_URL` if you changed the port (default `http://127.0.0.1:7878`).

### Local / development build

To test unreleased changes, point the client at the local file instead of `npx`:

```json
{
  "mcpServers": {
    "tucano": {
      "command": "node",
      "args": ["/absolute/path/to/tucano-proxy/packages/tucano-mcp/bin/tucano-mcp.js"],
      "env": { "TUCANO_TOKEN": "paste-the-token-from-tucano-settings" }
    }
  }
}
```

## Tools

### Status & discovery

| Tool | Description |
|---|---|
| `tucano_status` | Bridge + proxy status, flow count. |
| `tucano_list_flows` | List captured flows (summaries, **no bodies**). Filters: `host`, `path`, `method`, `status`, `statusClass` (`5xx`…), `statusMin`/`statusMax`, `contentType`, `clientApp`, `minDurationMs`, `minSize`, `q`, `since`. Pagination: `limit`, `offset`. |
| `tucano_search` | **Full-text search inside bodies + headers** (server-side). Returns flow ids + snippets. `scope` = `all`\|`body`\|`headers`. Far cheaper than downloading bodies to grep. |
| `tucano_stats` | Aggregates over all flows: counts by status class / method / host / content-type, total bytes, error count, slowest + largest flows, time range. |

### Reading flows

| Tool | Description |
|---|---|
| `tucano_get_flow` | Full flow record. `includeBodies:false` → metadata + headers only. |
| `tucano_get_request_body` | Request body, paged (`maxBytes`, `offset`) with `totalBytes`/`truncated`. `select` extracts a JSON sub-value (e.g. `data.items[*].id`). |
| `tucano_get_response_body` | Response body, same paging + `select` JSON extraction. |

### Live automation

| Tool | Description |
|---|---|
| `tucano_wait_for` | Block until a flow matching `host`/`path`/`method`/`status` is captured (or `timeoutMs`). One call instead of busy-polling. |
| `tucano_start_capture` | Turn on the proxy + flip the OS proxy. |
| `tucano_stop_capture` | Turn off the OS proxy + stop the proxy. |

### Mutations

| Tool | Description |
|---|---|
| `tucano_replay_flow` | Replay a flow. Tweak one header with `setHeaders`/`removeHeaders`, or replace all with `headers`; optional `body`. |
| `tucano_compose_request` | Send a brand-new request through Tucano (`log:false` to not persist). |
| `tucano_delete_flows` | Delete flows by id. |
| `tucano_clear_flows` | Wipe ALL captured flows (clean baseline). |

### Compare & export

| Tool | Description |
|---|---|
| `tucano_diff` | Structured diff of two flows: request line / status / duration, headers added/removed/changed, body equality. |
| `tucano_export_as_curl` | Render flows as ready-to-run `curl` commands. |
| `tucano_export_as_code` | Render flows as `fetch` / `axios` / `python` snippets. |
| `tucano_export_as_har` | Export flows as a standard HAR 1.2 log. |

### Configuration

| Tool | Description |
|---|---|
| `tucano_get_ssl_settings` | Read the SSL-proxying config. |
| `tucano_set_ssl_settings` | Configure which HTTPS hosts are decrypted (`mode` = `all`\|`allowlist`\|`blocklist`, `hosts`, `skipHosts`). Without this, untrusted HTTPS hosts are tunneled and their bodies aren't captured. Applies immediately to new traffic. |

## Spending fewer tokens

- **Filter, don't dump.** `tucano_list_flows` with `statusClass`/`host`/`contentType` beats listing everything.
- **Search server-side.** Use `tucano_search` instead of fetching bodies to grep them yourself.
- **Extract, don't read.** `select` on the body tools returns just the JSON slice you asked for.
- **Page big bodies.** `maxBytes`/`offset` keep large payloads out of context.
- **Aggregate.** `tucano_stats` answers "how many / how big / how slow" without listing rows.

## Security

The bridge is local-loopback only (`127.0.0.1`) and requires a Bearer token. Treat the token as sensitive — anything with it can read your captured traffic (including request/response bodies) and change SSL settings. Rotate from Settings if leaked.
