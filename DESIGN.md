# Tucano Proxy Design System

## Scope

Preserve the shipped product's visual identity while adding terminal and browser access. Source of truth: `src/styles.css`, `tailwind.config.js`, and the existing artwork. This is a product inspector, not a marketing landing page.

## Color

- Product accent: violet `#6A57E0` (`toucan.400`).
- Lighter accent for dark-surface legibility: `#9583E7` / `#BBADEE` from the same brand scale.
- Dark canvas: `#0F1014`.
- Light canvas: warm paper `#FBFBF8`.
- Light foreground: ink `#080D1B`.
- Dark foreground: `#EDEEF3`.
- Neutral data: ink scale from `tailwind.config.js` and semantic CSS tokens.

Selection, focus and primary actions use violet. Status/error/warning colors communicate meaning with text labels, not color alone. Do not assume a terminal's appearance matches its operating system. Adapt the palette to detected terminal capabilities and respect explicit user overrides.

## Typography

Web/desktop use Manrope for UI and JetBrains Mono for traffic/code. Newsreader is an existing editorial accent, not a data-table font. Terminal uses the user's monospace font; no Nerd Font requirement. Align by terminal display width, not byte length.

## Artwork

Use the supplied purple Tucano Proxy tile: `public/tucano-proxy.png` is the CLI/favicon master and `src/assets/tucano-proxy.png` is its byte-identical bundled frontend copy. Native icon variants are generated from this artwork. Preserve the supplied toucan, opposing arrows and internal shading; do not restore the retired flat SVG mark. Render the real logo only with a supported terminal graphics protocol. Provide a recognizable compact textual identity otherwise. Keep branding small during capture inspection; never print it in JSON or redirected output.

## Layout

Capture table, inspector, filters and status are the principal regions. Wide terminals can show a side inspector; narrower terminals use a bottom inspector or a dedicated detail screen. Preserve selection and reading position while events arrive. Configurable columns must not force horizontal overflow.

Web reuses existing React components and right/bottom/hidden inspector layouts. Platform adapters replace native dialogs and window actions without creating another frontend.

## Interaction

Keyboard-first navigation with contextual shortcuts and help. Mouse support supplements rather than replaces keyboard operation. Distinguish capture running/stopped, connection status and visual follow state. Destructive actions require deliberate confirmation. Errors stay visible and explain recovery.

## Rendering

Update only changed terminal cells, batch capture changes and fetch bodies on demand. Input remains responsive while network operations run. Restore cursor/raw mode on all exit paths. Render captured headers/bodies as untrusted data: never allow embedded escape sequences to execute terminal commands. Motion indicates actual activity and is omitted when not useful.
