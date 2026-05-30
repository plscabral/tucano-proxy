# Tucano Proxy

Open source HTTP/HTTPS debugging proxy — desktop app built with Tauri 2 + SolidJS.
Free alternative to Fiddler Classic / Proxyman, running natively on macOS (Apple Silicon + Intel) and Windows.

<p align="center">
  <img src="public/tucano-proxy.png" alt="Tucano Proxy" width="128" height="128" />
</p>

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

**App**

- Dark / Light theme — palette `#0C142E` ink, `#F99245` toucan accent
- Localized in English, Português (BR/PT) and Español
- Inspector layout: right pane, bottom pane, or hidden
- In-app auto-updater (signed releases via GitHub)

**Roadmap** — Composer / replay, breakpoints, AutoResponder, WebSocket frame inspector, gRPC, scripting.

## Downloads

Get the latest installer from **[Releases](https://github.com/plscabral/tucano-proxy/releases/latest)**:

- **macOS (Apple Silicon)** — `Tucano.Proxy_*_aarch64.dmg`
- **macOS (Intel)** — `Tucano.Proxy_*_x64.dmg`
- **Windows** — `Tucano.Proxy_*_x64-setup.exe` or `.msi`

### First-launch warnings

The app is currently **not code-signed**, so the OS will warn you the first time you open it.

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
| UI       | SolidJS + Vite + TailwindCSS |
| Editors  | CodeMirror 6 |
| Virtual  | @tanstack/solid-virtual |

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

## How it works

1. Hit the **Play** button in the toolbar (or press <kbd>Space</kbd>) — Tucano binds a hudsucker MITM proxy on `127.0.0.1:8888`.
2. Open **Settings → Certificate → Install CA** — your OS trusts the Tucano root, so HTTPS interception works without browser warnings.
3. Toggle **System proxy** in the status bar — Tucano flips the OS-level proxy so all traffic flows through it (and reverts on quit).
4. Browse / hit your APIs — flows stream into the list in real time. Click any to inspect headers, body (JSON / XML / HTML / Form / Raw / Hex / Image) and timing.

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

## Author

Created and maintained by **[Paulo Cabral](https://github.com/plscabral)**.

If you fork, build on, or redistribute Tucano Proxy, please keep the copyright
notice in `LICENSE` intact — it's the only thing the MIT license asks of you.

## License

[MIT](./LICENSE) © 2026 Paulo Cabral.
