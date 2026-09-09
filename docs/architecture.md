# Architecture

Tucano Proxy is one traffic-debugging engine with several clients. The standalone executable is `tucano-proxy`; it does not launch Tauri or require a graphical session.

## Packages

| Package | Responsibility |
| --- | --- |
| `crates/tucano-core` | HTTP proxy, certificate authority, traffic model, SQLite storage, capture lifecycle, sanitization and shared operations. No Tauri dependency. |
| `crates/tucano-service` | Authenticated loopback HTTP API, session ownership, runtime credentials, browser assets, event stream and graceful shutdown. |
| `crates/tucano-cli` | Command parsing, structured output, daemon discovery, diagnostics, skill distribution and interactive terminal UI. |
| `src` | Shared React inspector used by desktop and local web, with platform/transport adapters. |
| `src-tauri` | Native desktop shell and adapters to the shared core. Kept outside the standalone workspace to avoid linking a graphical runtime into the CLI. |

The root Cargo workspace builds the standalone product. Build frontend assets with `pnpm build` before compiling the service/CLI; release binaries embed the generated assets. Desktop builds remain `pnpm tauri build`.

## Two separate network roles

The proxy listener receives the application's HTTP/HTTPS traffic. The control listener serves the inspector and authenticated API. These use separate ports (normally 8888 and 7777). Neither should be exposed beyond loopback.

A CLI command does not magically route another application's traffic. Configure that application's proxy and, for intercepted HTTPS, trust in the appropriate public CA. System-wide proxy changes and certificate installation are explicit operations, not requirements of inspecting a saved session.

## Lifetime and ownership

The local service owns active connections and the session database. Commands and UI clients attach to it; closing the browser or terminal inspector does not implicitly terminate the service. A named session has one owning service at a time. Different active sessions need distinct listener ports.

A runtime descriptor is discovery metadata, not permission to kill a PID. Clients verify service identity/readiness and use authenticated shutdown. Session locks prevent concurrent owners. Credentials in the descriptor are local secrets and must not be printed in ordinary status/log output.

Global OS proxy changes require machine-level coordination in addition to per-session isolation. The service must preserve and restore previous settings; a session that does not own the global proxy must not change it.

## Shared operations and events

Core operations are exposed through one dispatch contract. Native desktop adapters and HTTP transport invoke the same behavior rather than duplicating capture, replay or persistence logic.

Events carry an instance-local monotonic sequence, event name and payload. Clients must resynchronize from stored state after a stream gap or service restart; reconnection alone does not prove no events were missed. Viewing selection, scroll position and filters belong to each client. Notes, marks and captured evidence belong to the session.

The human terminal interface uses a bounded metadata query and loads selected bodies on demand. Machine clients use the command/API JSON contracts instead of driving the TUI.

## Web adaptation

The web build reuses the React capture list, inspector, composer, comparison and exporters. Platform adapters replace native invoke/event calls and file dialogs with authenticated HTTP/events and browser uploads/downloads. Native window controls and desktop self-update are not browser capabilities.

Browser requests cannot supply arbitrary filesystem paths for read/write. Session upload/download has dedicated endpoints. Browser authentication exchanges a fragment credential for a restricted local cookie; the launch fragment must be removed after exchange.

## Compatibility

Machine responses identify API version 1. Additive fields are preferable to changing existing types or meanings. Persisted sessions must be validated before replacement and imported atomically. Unknown future schemas must fail with a recoverable error rather than silently discard data.

Terminal capabilities vary. Automatic theme detection has a bounded fallback; Unicode and images are enhancements, not prerequisites. The TUI does not attempt to render browser HTML as a web engine.
