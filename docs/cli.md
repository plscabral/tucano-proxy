# Tucano Proxy CLI

`Tucano` is the family name; `Tucano Proxy` is the network-debugging product. The standalone executable is `tucano-proxy`. CLI commands, an interactive terminal inspector and an optional local web inspector use the same session data. No desktop installation is required.

## Install and build

Download the native CLI archive and matching `.sha256` from [Releases](https://github.com/plscabral/tucano-proxy/releases). CLI assets are named `tucano-proxy-<target>.tar.gz` on macOS/Linux and `tucano-proxy-x86_64-pc-windows-msvc.zip` on Windows. They are separate from the Tauri desktop installers.

The reviewed installer sources are `scripts/install.sh` and `scripts/install.ps1`. They verify SHA-256 before replacing the executable and do not change PATH, certificates or system proxy settings. Set `TUCANO_VERSION` to a release tag to pin a version and `TUCANO_INSTALL_DIR` to choose a destination. Rerunning the installer updates the binary without deleting session data. Published release availability is independent of building from source.

### Native installers

Once the standalone release is published, the release includes the reviewed installer sources:

```sh
curl -fsSL https://github.com/plscabral/tucano-proxy/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/plscabral/tucano-proxy/releases/latest/download/install.ps1 | iex
```

These commands execute downloaded code. Download and inspect the script first if required by your security policy. Native archives and their SHA-256 files remain available for manual installation. Unix defaults to `~/.local/bin`; Windows defaults to `%LOCALAPPDATA%\\TucanoProxy\\bin`. Add that directory to your PATH; neither installer edits your shell profile.

### Package managers

These commands require the corresponding package to have been published; a generated manifest alone is not a live catalog entry. WinGet also requires acceptance of its upstream pull request.

```sh
npm install -g tucano-proxy
brew install plscabral/tap/tucano-proxy
```

```powershell
winget install --id PauloCabral.TucanoProxy.CLI --exact
```

npm requires Node.js 18+ and optional dependencies enabled. It installs an exact-version prebuilt platform package; no compiler, desktop dependency or postinstall binary download is needed. `npx tucano-proxy --help` is also supported after npm publication. Homebrew installs the native binary and Bash, Zsh and Fish completions.

Supported native targets are macOS Apple Silicon/Intel, Linux glibc ARM64/x64 and Windows x64. Linux x64 releases are built on Ubuntu 22.04 (glibc 2.35), ARM64 on Ubuntu 24.04 (glibc 2.39); Alpine/musl is not a supported prebuilt target. Windows ARM64 requires working x64 emulation; npm additionally requires x64 Node.js.

### Agent skill

The skill is procedural guidance, not the executable. Install it independently:

```sh
npx skills add plscabral/tucano-proxy --skill tucano-proxy
```

The source is `skills/tucano-proxy/SKILL.md`; the default-branch command works after that file is published there. To pin the skill to a published release, use its tag URL (branch names containing slashes are not handled reliably by the skills CLI):

```sh
npx skills add https://github.com/plscabral/tucano-proxy/tree/v0.2.7/skills/tucano-proxy
```

`npx skills add ./skills --list` checks local discovery without installing anything. The skill is also included in the native archives and `tucano-proxy-skill.zip`. A public GitHub source is discoverable by the skills CLI; the skills.sh leaderboard uses installation telemetry rather than an npm-style skill publication command.

### Build from source

From source, with Node/pnpm and stable Rust installed:

```sh
pnpm install
pnpm build:cli
./target/release/tucano-proxy --version
```

The frontend build is embedded into the native CLI. Node and Vite are build-time requirements, not runtime requirements for the installed CLI. Windows uses `target/release/tucano-proxy.exe`.

## First session

Run `tucano-proxy --session checkout setup` for the guided first-use flow. A bare interactive launch runs this wizard until setup is complete for the selected session; later bare launches open the TUI. Explicit commands, redirected input/output and `--json` never enter the wizard.

Setup uses an inline welcome panel, the Tucano wordmark and one decision at a time. Use Up/Down (or j/k) and Enter to choose, `d` for session/certificate details, and Esc, q or Ctrl-C to cancel. Suggested free ports are selected first; manual port fields support cursor editing and Ctrl-U to clear. Details scroll with Up/Down. Narrow terminals use a compact layout; an undersized terminal cannot confirm hidden choices. The panel inherits the terminal background and respects `--color never` / `NO_COLOR`. Redirected output and `setup --status` remain ordinary text or JSON.

The wizard reuses a verified service and existing session CA, chooses free local ports for a new service, checks trust for the **exact certificate**, and offers certificate installation, capture and an interface separately. Trust installation is opt-in; OS proxy settings are never changed by setup. Declining trust/capture is valid. macOS/Windows support automatic trust inspection; other platforms get export/manual instructions. A desktop CA or another session's CA is not silently copied or treated as this session's certificate.

`setup --status --json` is read-only, including when the service is stopped. It distinguishes missing, existing and damaged certificate material and unknown/unsupported OS trust. It never repairs or regenerates a certificate. Successful setup writes a private session-scoped `setup.json`; rerunning setup preserves CA/captures. Saved ports are reused when starting a stopped session unless explicit port flags override them. Cancelling does not mark setup complete and does not stop an existing service.

Installers report existing certificate/setup status after installing the binary and show the wizard command. Interactive Unix installation offers to launch it; scripted installation never prompts. Windows prints the explicit command rather than accidentally prompting from a piped installer.

```sh
tucano-proxy doctor
tucano-proxy --session checkout start --proxy-port 8888 --web-port 7777
tucano-proxy --session checkout status
tucano-proxy --session checkout tui
```

`start` runs a persistent background service. `start --foreground` keeps the service attached for process supervisors. The terminal inspector is a client: closing it does not stop the service. Use `stop` when finished.

Starting an ordinary proxy does not change the OS proxy or install a certificate. Configure the target application to route its traffic through `127.0.0.1:8888`. Clients differ in how they honor proxy settings and whether they bypass loopback. For example, explicitly point curl at the proxy when diagnosing local endpoints:

```sh
curl --proxy http://127.0.0.1:8888 --noproxy '' http://127.0.0.1:3000/health
```

For HTTPS, configure the target runtime to trust the exported public session CA. Do not use disabled TLS verification as a substitute for correct trust configuration. Read [Security](security.md) before global certificate or system-proxy changes.

## CLI updates

```sh
tucano-proxy update --check
tucano-proxy update --check --json
tucano-proxy update
tucano-proxy update --yes --json
```

Checks use the official stable GitHub release metadata and do not run implicitly on every command. An update requires a newer semantic version and the matching standalone CLI archive plus its checksum. Desktop installers are never substituted; a release without CLI assets is reported as unavailable.

Interactive updates ask before replacement; scripts must explicitly pass `--yes`. Downloads use verified HTTPS and bounded sizes, SHA-256 is checked before extraction, and only the expected regular executable is extracted and version-checked. The executable is replaced without modifying sessions, certificates, setup state or capture settings. This checksum verifies integrity against the official HTTPS release channel; it is not a separate signing identity.

Already-running services keep their loaded version. Restart each session deliberately after an update when its capture can be interrupted; the updater never stops services or changes system networking on your behalf. Updating from source remains possible with `pnpm build:cli`.

For npm, Homebrew and WinGet installations, `update --check` remains read-only and reports `installChannel`, `installPackage`, `updateCommand`, `selfUpdateAllowed` and any `installationError`. Native replacement is refused even with `--yes`; update through the owner:

```sh
npm install -g tucano-proxy@latest
brew upgrade plscabral/tap/tucano-proxy
```

```powershell
winget upgrade --id PauloCabral.TucanoProxy.CLI --exact
```

Malformed or unknown installation ownership fails closed rather than treating a managed binary as standalone. Removing the launcher does not remove session data, certificates or system proxy configuration. Before uninstalling a proxy you are using, stop its owned sessions and restore routing deliberately; do not uninstall unrelated session certificates.

| Installation | Remove the executable |
| --- | --- |
| npm | `npm uninstall -g tucano-proxy` |
| Homebrew | `brew uninstall plscabral/tap/tucano-proxy` |
| WinGet | `winget uninstall --id PauloCabral.TucanoProxy.CLI --exact` |
| Native | Remove only the installed `tucano-proxy` / `tucano-proxy.exe` from the chosen installation directory |

### Release maintainers

`release-cli.yml` builds and smoke-installs all five native targets independently of the desktop workflow. A tag must match all product versions. All native jobs must pass before npm packages, Homebrew/WinGet manifests, installers and the skill archive are assembled and attached to a release **draft**. Review the artifacts before publishing; `scripts/publish-release.py --publish` refuses to replace an already-public release.

`distribution.yml` runs after publication or can be dispatched for a specific tag. Native npm packages publish before the launcher. Configure npm trusted publishing for every package and this workflow, or provide a suitable `NPM_TOKEN`; first publication may require an authenticated maintainer. Homebrew and WinGet automation use `DISTRIBUTION_GITHUB_TOKEN`, authorized to update `plscabral/homebrew-tap`, create/update the publisher's WinGet fork, and open an upstream PR. The source repository's default `GITHUB_TOKEN` cannot write those external repositories.

Manual equivalents after downloading a complete release:

```sh
python3 scripts/package-npm.py --artifacts release
python3 scripts/package-managers.py --artifacts release --output release/package-managers
python3 scripts/publish-npm.py --packages release/npm
python3 scripts/publish-homebrew.py --formula release/package-managers/Formula/tucano-proxy.rb
python3 scripts/submit-winget.py --manifests release/package-managers --version 0.2.7
```

## Command groups

Run `tucano-proxy <command> --help` for exact arguments and defaults. The executable's clap metadata is the authoritative command reference and also generates shell completions.

| Command | Purpose |
| --- | --- |
| `start`, `serve`, `stop`, `status` | Own, discover and stop a local service; inspect readiness. |
| `web` | Report the local inspector address, or open it with authentication using `--open`. |
| `tui` | Interactive capture table and detailed inspector, with automatic or explicit theme. |
| `doctor` | Non-mutating diagnostic of the installation/session environment. |
| `setup`, `setup --status` | Guided first use, or read-only inspection of this session's existing certificate and setup. |
| `update`, `update --check` | Explicit native CLI update, or read-only official release check. |
| `mcp-stdio` | Bridge MCP using the selected existing session's configuration, without a desktop dependency. |
| `flows list`, `flows get` | Filter/page summaries and fetch selected evidence. |
| `flows note`, `flows mark` | Annotate shared session evidence. |
| `flows delete`, `flows clear` | Deliberately remove retained captures. |
| `capture start`, `capture stop` | Control traffic capture independently of the service/UI lifetime. |
| `compose`, `replay` | Send an authorized HTTP request or reproduce a retained one. |
| `export` | Export selected evidence in supported formats. |
| `session` | List/create/remove sessions and import/export portable SQLite evidence. |
| `ca` | Inspect/export the CA and explicitly manage trust where supported. |
| `ssl` | Inspect or update HTTPS interception settings. |
| `privacy` | Inspect or change private capture policy. |
| `config` | Read/write persistent capture retention settings. |
| `auth` | Inspect scoped access credentials explicitly or rotate them. |
| `completions` | Generate shell completions from actual command metadata. |
| `skill` | Install, inspect or remove the official coding-agent skill. |

Use explicit named sessions to isolate projects. Active sessions need distinct API/proxy ports. A session name is not an arbitrary path; use `--data-dir` to choose the root storage location. Do not share private data directories across untrusted users.

## Machine output

Use global `--json` for scripts and agents. Successful responses have a versioned envelope:

```json
{"apiVersion":1,"result":{"running":true}}
```

The `result` shape depends on the command; the example only illustrates the envelope. Failure responses have `apiVersion` and `error` with a stable category `code` and a human-readable `message`. Check the process exit code. A sent request can return HTTP 4xx/5xx successfully at the transport level, so inspect the response status too.

Exit categories:

| Code | Meaning |
| --- | --- |
| 0 | Command completed; inspect HTTP response status separately. |
| 2 | Invalid command or arguments. |
| 3 | Local service unavailable or readiness timeout. |
| 4 | Authentication, authorization or service identity failure. |
| 5 | Local filesystem/I/O failure. |
| 6 | Requested operation failed. |
| 7 | Explicit confirmation required. |

JSON output contains no terminal branding, animations or ANSI styling. Operational diagnostics go to stderr. `NO_COLOR` or `--color never` disables human-output color. Redirected output is not an interactive inspector.

Human `start`/`web` output presents readiness, session, live capture/routing state and runnable next commands rather than a raw runtime object. `--json` retains its machine-readable envelope. This follows the [CLI Guidelines](https://clig.dev/#output) distinction between human and machine output; the setup sequence follows the [mitmproxy getting-started](https://docs.mitmproxy.org/stable/overview/getting-started/) separation of proxy routing, certificate trust and verification.

Use bounded metadata queries and fetch only bodies needed for the task. Filters accept field rules such as host, path, method, status, duration, MIME and scheme, plus free text; numeric fields support comparisons. Consult `flows list --help` for the exact filter, limit, offset and sort flags.

## Terminal inspector

```sh
tucano-proxy --session checkout tui --theme auto
tucano-proxy --session checkout tui --theme light
tucano-proxy --session checkout tui --theme dark
```

The inspector combines a capture table with request/response details. Use its contextual help for navigation, filtering, sorting, column selection, multiple selection, notes, marks, comparison, composer/replay, export and deletion. Keyboard operation does not require mouse support or a special font.

Press `?` or F1 for help. Left/Right or Tab switches between Captures, Inspect, Compose, Filter and About; `1`–`5` jumps directly to a section. The footer stays visible while Up/Down, PageUp/PageDown or the mouse wheel scrolls the section. Esc closes help before workspace shortcuts can be used.

In the workspace, `d`, Delete or the Mac Delete/Backspace key requests deletion of the selected captures (or the highlighted capture when no multi-selection is active). `D` (Shift+D) clears **all captures in the session**, including traffic hidden by a filter. Both actions require `y` to confirm; `n` or Esc cancels. Clearing retained captures does not stop the listener, so new traffic can appear immediately.

Automatic theme detection asks compatible terminals for their background and has a bounded fallback. Manual light/dark selection is available. Tucano artwork uses supported terminal image capabilities and otherwise falls back to a compact textual identity. Narrow windows adapt the layout; long body contents remain scrollable.

In the Body tab (`3`), `J` toggles Preview/Source and `w` toggles Wrap/No-wrap (wrapping is on initially). HTML preview renders readable text, headings, lists and link references; it does not execute JavaScript, apply browser CSS or fetch images/links. JSON and XML previews indent structured content; JSON preserves numeric spelling and duplicate keys. Source retains the original captured representation.

Use Shift+Left/Right to pan horizontally in No-wrap mode, and `G`/End to reach the bottom. Wrapped scrolling follows rendered lines, including after resizing the terminal. Inspection reads at most 128 KiB; truncation and malformed structured content are reported instead of silently presenting a complete document.

Pausing live following freezes the reading position, not the network capture. Capture status and follow state are displayed separately. The terminal is restored on exit; the background service remains available to other clients.

## Local web inspector

```sh
tucano-proxy --session checkout web --open
```

The browser and terminal observe the same session. The web inspector reuses the desktop React interface, including filtering, detailed views, comparison, composer and exporters. Browser session save/open uses downloads/uploads instead of remote filesystem paths.

The authenticated launch URL contains a local credential in its fragment. Do not copy it into shared chats or issues. The browser exchanges it for an HttpOnly cookie and removes the fragment. Closing the tab does not stop capture. The web page reconnects and resynchronizes after event gaps rather than assuming every event was delivered.

`web --open --target auto` is the default. In an interactive Maestri or Orca terminal it offers the app's embedded browser, the system browser, or cancellation. With `--json` or redirected stdin/stdout it never prompts: `auto` selects the detected app, otherwise the system browser. Explicit targets bypass the question:

```sh
tucano-proxy --session checkout web --open --target maestri
tucano-proxy --session checkout web --open --target orca
tucano-proxy --session checkout web --open --target browser
```

Maestri detection requires nonempty `MAESTRI_SOCKET` and `MAESTRI_TERMINAL_ID`; the opener uses `MAESTRI_CLI` or `maestri` on PATH to create a linked Portal. Orca detection uses `TERM_PROGRAM=Orca`, `ORCA_CLI_COMMAND` or `ORCA_DEV_REPO_ROOT`; its public CLI creates a **new tab in the calling workspace**, not a navigation of the active tab. The app-scoped Maestri signals take precedence if both environments are inherited. Orca's executable selection honors its WSL/dev overrides and uses `orca-ide` on Linux outside managed Orca terminals.

Maestri receives the complete authenticated URL directly. Orca authenticates inside the new, origin-checked tab before reloading it, keeping the credential out of its saved tab URL. Neither integration prints app-client output or credentials. JSON results report `openedIn`; human output confirms the destination without advertising a bare URL for terminal port detectors. A plain `web` result, or a terminal's automatically detected `localhost` link, is **not an authenticated launch**. Use `web --open` rather than dropping the URL fragment or changing `127.0.0.1` to `localhost`: browser cookies are host-specific. `start --open` continues to use the system browser.

The raw request composer preserves edits to the request target and text body, including leading/trailing whitespace. Binary or truncated captured bodies require an explicit text replacement in the composer; use Replay for a complete original binary request.

## MCP integration

Enable MCP explicitly in the selected session's **Settings → MCP** before calling its tools. `tucano-proxy --session checkout mcp-stdio` reads that session's existing MCP URL, token and autolaunch settings. It does not silently enable MCP or fall back to a different desktop/session. Initialization, ping and tool discovery remain available for an existing session whose MCP endpoint is disabled; tool calls explain the disabled state.

Generated MCP/Pi launchers carry the service data directory and session. Explicit `TUCANO_MCP_URL`, `TUCANO_MCP_TOKEN`, `TUCANO_MCP_AUTOLAUNCH`, `TUCANO_MCP_DATA_DIR` and `TUCANO_MCP_SESSION` environment overrides remain supported. The stdio command owns stdout for JSON-RPC and must not be combined with `--json`.

## Agent skill

The official source is [`skills/tucano-proxy/SKILL.md`](../skills/tucano-proxy/SKILL.md). `skill --help` describes installation scopes and supported agents. The skill teaches request diagnosis, bounded queries, safe replay, proxy/trust setup and sanitized evidence collection. It does not replace the executable or grant OS permissions.

Install it in the coding agent actually running inside Maestri, Orca or another terminal host. Prefer read-only credentials when a worker only needs inspection. Never use an agent's possession of a token as authorization to replay production mutations.

## Performance and compatibility checks

Use a disposable session for a repeatable local workload:

```sh
python3 scripts/benchmark.py --proxy-port 8888 --requests 1000 --concurrency 8 --json
python3 scripts/benchmark.py --direct --requests 1000 --concurrency 8 --json
```

The benchmark starts a finite loopback origin, verifies the forwarded bodies and reports throughput plus p50/p95/p99 latency. Direct and proxied runs are separate measurements; record platform, version, body size and capture settings when comparing results. These measurements are not universal product performance guarantees.

Build/quality commands:

```sh
pnpm typecheck
pnpm build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
pnpm tauri build
```

The standalone CI matrix covers macOS, Windows and Linux; platform-specific trust and proxy behavior must be tested on the actual target system. Defining a CI job does not establish that it has run successfully.

See [Architecture](architecture.md) for package boundaries and [Security](security.md) for trust, credential and sharing policies.
