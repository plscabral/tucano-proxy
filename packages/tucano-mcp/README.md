# tucano-mcp

MCP server that exposes [Tucano Proxy](https://github.com/plscabral/tucano-proxy)'s captured HTTP/HTTPS flows to LLM clients (Claude Desktop, Claude Code, Cursor, etc).

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

## Tools

| Tool | Description |
|---|---|
| `tucano_status` | Bridge + proxy status, flow count. |
| `tucano_list_flows` | List captured flows. Returns summaries — bodies omitted. Supports `host`, `method`, `status`, `q`, `limit` filters. |
| `tucano_get_flow` | Full flow record including bodies. |
| `tucano_get_request_body` | Decoded request body (utf8 or base64). |
| `tucano_get_response_body` | Decoded response body (utf8 or base64). |
| `tucano_replay_flow` | Replay an existing flow with optional header/body overrides. |
| `tucano_compose_request` | Send a brand-new request through Tucano. |
| `tucano_delete_flows` | Delete flows by id. |

## Security

The bridge is local-loopback only (`127.0.0.1`) and requires a Bearer token. Treat the token as sensitive — anything with it can read your captured traffic (including request/response bodies). Rotate from Settings if leaked.
