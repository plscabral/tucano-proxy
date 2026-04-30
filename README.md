# Tucano

Open source HTTP/HTTPS debugging proxy — desktop app built with Tauri 2 + SolidJS.
Free alternative to Fiddler Classic / Proxyman, running natively on macOS (Apple Silicon + Intel) and Windows.

![logo](src/assets/logo.png)

## Features (v0.1)

- MITM proxy on `127.0.0.1:8888` (configurable) — HTTP, HTTPS, WebSocket
- Self-generated root CA with one-click install into the OS trust store
- One-click toggle of the system proxy (macOS `networksetup`, Windows registry)
- Virtualized flow list — handles tens of thousands of captures
- Inspector with auto-detected viewers: JSON tree, XML, HTML, Raw, Hex, Image
- Filter DSL: `host:api.foo.com status:>=400 method:POST`
- Save/load capture sessions as `.tucano` (SQLite)
- Dark / Light theme — palette `#0C142E` ink, `#F99245` toucan accent

Roadmap: Composer/replay, breakpoints, AutoResponder, WebSocket frames, HAR/cURL export, gRPC, scripting.

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

1. Click **Start** — Tucano binds a hyper-based MITM proxy on `127.0.0.1:8888`.
2. Click **Install CA** — your OS trusts the Tucano root, so HTTPS interception works without browser warnings.
3. Click **System proxy** — Tucano flips the OS-level proxy so all traffic flows through it (and reverts on quit).
4. Browse / hit your APIs — flows stream into the list in real time. Click any to inspect headers, body (JSON/XML/HTML/raw/hex/image), and timing.

## License

MIT.
