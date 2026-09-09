# Tucano Proxy

Open source HTTP/HTTPS debugging proxy with a standalone native CLI, interactive terminal inspector, local web UI, and Tauri desktop app.
The CLI runs without a graphical session. CLI, TUI and web share persistent named sessions; the desktop uses the same Rust core.

<p align="center">
  <img src="public/tucano-proxy.png" alt="Tucano Proxy" width="128" height="128" />
</p>

## Choose your interface

| Interface | Use it for |
| --- | --- |
| **CLI** | Structured commands, automation and coding agents, with versioned JSON output. |
| **Terminal UI** | Live capture table, filtering and request/response inspection without a browser. |
| **Local web** | The React inspector in your browser, served by the native executable. |
| **Desktop** | Native window integration and the existing Tauri experience. |

```sh
# Build the standalone CLI, including its web assets
pnpm install
pnpm build:cli

./target/release/tucano-proxy --session my-project start
./target/release/tucano-proxy --session my-project tui --theme auto
./target/release/tucano-proxy --session my-project web --open
```

Starting the CLI proxy does **not** silently change system proxy settings or install a certificate.
Configure the target application to use the proxy. Closing the TUI or browser does not stop the service.

See the [CLI guide](docs/cli.md), [architecture](docs/architecture.md), [security boundaries](docs/security.md), and [official agent skill](skills/tucano-proxy/SKILL.md).

## Features

**Capture & inspection**

- MITM proxy on `127.0.0.1:8888` (configurable) — HTTP, HTTPS, WebSocket
- Self-generated root CA with one-click install into the OS trust store
- One-click toggle of the system proxy (macOS `networksetup`, Windows registry)
- Per-host SSL allowlist / blocklist (skip MITM on hosts you don't own)
- Virtualized flow list — handles tens of thousands of captures
- Inspector with auto-detected viewers: JSON tree, XML, HTML, Raw, Hex, Image, Form (urlencoded / multipart)
- Headers, timing, and response/request bodies side-by-side
- Customizable columns: drag to reorder, drag the right edge to resize, **double-click to auto-fit**

**Workflow**

- Filter DSL: `host:api.foo.com status:>=400 method:POST` with multi-rule AND
- Category tabs: HTTP, HTTPS, WebSocket, JSON, Form, XML, JS, CSS, GraphQL, Document, Media, Other
- **Compare** any two captures with header / body diff (`⌘D`)
- **Find All** across all captured flows — URL, body, notes — with live highlight (`⌘⇧F`)
- Color marks per capture (`⌘0`–`⌘6`) and inline notes per capture (`M`)
- Save / load capture sessions as `.tucano` (SQLite, portable)
- Export selected flows as cURL (bash / cmd), PowerShell, JS `fetch`, Python `requests`, HTTPie, raw HTTP/1.1, or HAR 1.2
- Composer and editable replay for authorized HTTP requests
- MCP integration and an installable CLI skill for coding agents

**App**

- Dark / Light theme — violet brand accent (`#6A57E0`) on a deep `#0F1014` canvas
- Localized in English, Português (Brasil) and Español
- Inspector layout: right pane, bottom pane, or hidden
- In-app auto-updater (signed releases via GitHub)

**Roadmap** — breakpoints, AutoResponder, WebSocket frame inspector, gRPC, executable scenarios.

## Downloads

Get the latest installer from **[Releases](https://github.com/plscabral/tucano-proxy/releases/latest)**:

- **macOS (Apple Silicon)** — `Tucano.Proxy_*_aarch64.dmg`
- **macOS (Intel)** — `Tucano.Proxy_*_x64.dmg`
- **Windows** — `Tucano.Proxy_*_x64-setup.exe` or `.msi`

Standalone CLI archives are separate assets named `tucano-proxy-<target>.tar.gz` (macOS/Linux) or `tucano-proxy-x86_64-pc-windows-msvc.zip`, with matching SHA-256 checksums. The release workflow builds macOS ARM64/Intel, Linux ARM64/x64 and Windows x64 binaries. See [installation and updates](docs/cli.md#install-and-build).

The CLI does not require the desktop app. Use the [installation guide](docs/cli.md#install-and-build) for native shell/PowerShell installers, npm, Homebrew and WinGet commands and their publication prerequisites. `tucano-proxy setup` configures a session, `tucano-proxy tui` opens the terminal inspector, and `tucano-proxy web --open` opens the authenticated web interface, with automatic Maestri/Orca detection. The last command does not launch the native desktop app.

Install the coding-agent skill separately after it is available in the repository's default branch:

```sh
npx skills add plscabral/tucano-proxy --skill tucano-proxy
```

The same skill is included in native archives and can be installed offline with the CLI's `skill` commands.

### First-launch warnings

Desktop OS code signing/notarization depends on release credentials; the current desktop documentation assumes an unsigned build, so the OS may warn on first launch. CLI archive checksums verify integrity and are not a substitute for OS code signing.

**macOS** — after dragging to `/Applications`, do one of:

- Right-click the app → **Open** → **Open** in the dialog, or
- *System Settings → Privacy & Security → "Open Anyway"*.

> If you ever see *"is damaged and can't be opened"*, run once:
> `xattr -cr "/Applications/Tucano Proxy.app"`

**Windows** — SmartScreen will say "Windows protected your PC". Click **More info → Run anyway**.

## Stack

| Layer    | Tech |
|----------|------|
| Shell    | Tauri 2 (Rust) |
| Proxy    | hudsucker (hyper + rustls), rcgen |
| Storage  | SQLite (rusqlite, bundled) |
| UI       | React + Vite + Tailwind CSS (shadcn/ui) |
| Editors  | CodeMirror 6 |
| Virtual  | @tanstack/react-virtual |

## Getting started

Requirements: Node 20+, pnpm, Rust stable (`rustup`), Tauri prerequisites (https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev
```

Build native bundles:

```bash
pnpm tauri build                     # current target
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
pnpm tauri build --target x86_64-pc-windows-msvc
```

## Desktop workflow

1. Hit the **Play** button in the toolbar (or press <kbd>Space</kbd>) — Tucano binds a hudsucker MITM proxy on `127.0.0.1:8888`.
2. Open **Settings → Certificate → Install CA** — your OS trusts the Tucano root, so HTTPS interception works without browser warnings.
3. Toggle **System proxy** in the status bar — Tucano flips the OS-level proxy so all traffic flows through it (and reverts on quit).
4. Browse / hit your APIs — flows stream into the list in real time. Double-click a capture to inspect headers, body (JSON / XML / HTML / Form / Raw / Hex / Image) and timing.

## Shortcuts

| Action | Shortcut |
|---|---|
| Start / stop capture | <kbd>Space</kbd> |
| Focus / add filter | <kbd>⌘</kbd> <kbd>K</kbd> |
| Remove last filter | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> |
| Search inside body | <kbd>⌘</kbd> <kbd>F</kbd> |
| Find All across captures | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>F</kbd> |
| Compare two selected captures | <kbd>⌘</kbd> <kbd>D</kbd> |
| Save / open session | <kbd>⌘</kbd> <kbd>S</kbd> / <kbd>⌘</kbd> <kbd>O</kbd> |
| Clear all flows | <kbd>⌘</kbd> <kbd>L</kbd> |
| Select all visible | <kbd>⌘</kbd> <kbd>A</kbd> |
| Mark with color | <kbd>⌘</kbd> <kbd>0</kbd>–<kbd>⌘</kbd> <kbd>6</kbd> |
| Add / edit note | <kbd>M</kbd> |
| Delete selected | <kbd>Delete</kbd> / <kbd>Backspace</kbd> |
| Switch category tab | <kbd>1</kbd>–<kbd>9</kbd> |
| Settings | <kbd>⌘</kbd> <kbd>,</kbd> |
| Close inspector / Find All | <kbd>Esc</kbd> |

Use <kbd>Ctrl</kbd> in place of <kbd>⌘</kbd> on Linux / Windows. The full list lives under **Settings → Keyboard shortcuts**.

## 0.2.7 release notes

- Added a standalone Rust CLI, persistent named sessions, an interactive terminal inspector and a bundled local web UI. Desktop and standalone clients now share the same capture engine.
- Added versioned JSON commands, session-aware MCP stdio, official agent-skill installation, diagnostics and native CLI release archives.
- Preserved streaming uploads/downloads independently of inspection limits, including binary capture, replay and export.
- Added scoped local credentials, revocation, atomic session imports and private/no-log capture controls. TLS verification is secure by default; changing explicit host exceptions invalidates existing upstream connections.
- Updated the Tucano Proxy artwork in the application, terminal image support and native icons.
- Added textual HTML, lossless-number JSON and XML previews to the TUI, with Preview/Source and Wrap/No-wrap controls.
- Added authenticated Maestri Portal and Orca browser opening through `web --open`, with terminal detection, interactive destination selection and explicit `--target` options for agents.
- Corrected Raw copy-button contrast in both themes and replaced unavailable web certificate actions with session-aware installation/removal instructions and PEM export.
- Added a first-use setup wizard, non-mutating exact-certificate detection, remembered session ports and explicit native CLI update checks/replacement.
- Added npm packages with prebuilt platform binaries, checksum-derived Homebrew and WinGet manifests, and independent standalone CLI release builds.
- Package-managed installations now refuse native self-update and direct users to their original package manager.
- Reorganized terminal help into navigable sections and corrected Mac Delete handling, with explicit confirmation before removing captures.

See [CLI usage](docs/cli.md), [architecture](docs/architecture.md) and [security boundaries](docs/security.md) for contracts and operational details.

## Author

Created and maintained by **[Paulo Cabral](https://github.com/plscabral)**.

If you fork, build on, or redistribute Tucano Proxy, please keep the copyright
notice in `LICENSE` intact — it's the only thing the MIT license asks of you.

## License

[MIT](./LICENSE) © 2026 Paulo Cabral.
