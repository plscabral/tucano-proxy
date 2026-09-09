#!/bin/sh
# Install a released Tucano Proxy CLI without changing shell configuration.
set -eu

REPOSITORY=plscabral/tucano-proxy
VERSION=${TUCANO_VERSION:-latest}
INSTALL_DIR=${TUCANO_INSTALL_DIR:-"$HOME/.local/bin"}

DESTINATION="$INSTALL_DIR/tucano-proxy"
ACTION=Installing
[ ! -e "$DESTINATION" ] || ACTION=Updating
# Printed commands must also work before the installation directory is on PATH.
QUOTED_DESTINATION=$(printf '%s' "$DESTINATION" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/")
fail() { printf 'tucano-proxy: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
case "$VERSION" in
  latest) BASE="https://github.com/$REPOSITORY/releases/latest/download" ;;
  v[0-9]*)
    case "$VERSION" in *[!a-zA-Z0-9._-]*) fail 'Invalid release version' ;; esac
    BASE="https://github.com/$REPOSITORY/releases/download/$VERSION" ;;
  *) fail 'TUCANO_VERSION must be latest or a release tag such as v0.2.6' ;;
esac
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) TARGET=aarch64-apple-darwin ;;
  Darwin:x86_64) TARGET=x86_64-apple-darwin ;;
  Linux:x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux:aarch64|Linux:arm64) TARGET=aarch64-unknown-linux-gnu ;;
  *) fail 'Unsupported OS/architecture. See the release assets for available binaries.' ;;
esac
ASSET="tucano-proxy-$TARGET.tar.gz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
printf '%s Tucano Proxy in %s\n' "$ACTION" "$INSTALL_DIR"
printf 'Downloading %s (%s)…\n' "$ASSET" "$VERSION"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 "$BASE/$ASSET" -o "$TMP/$ASSET" ||
  fail 'Standalone CLI archive unavailable for this release/platform. Desktop release assets cannot be used as CLI updates; the current installation was not changed.'
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 "$BASE/$ASSET.sha256" -o "$TMP/checksum"
EXPECTED=$(cut -d ' ' -f 1 "$TMP/checksum")
case "$EXPECTED" in *[!a-fA-F0-9]*|'') fail 'Invalid checksum file' ;; esac
[ "${#EXPECTED}" -eq 64 ] || fail 'Invalid SHA-256 length'
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/$ASSET" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | cut -d ' ' -f 1)
else
  fail 'sha256sum or shasum is required to verify the download'
fi
[ "$EXPECTED" = "$ACTUAL" ] || fail 'SHA-256 mismatch; the current installation was not changed'
# Stream just the expected member to a fresh file; archive paths and links are never materialized.
# Reject duplicates and non-regular entries before reading their contents.
MEMBERS=$(tar -tzf "$TMP/$ASSET")
[ "$(printf '%s\n' "$MEMBERS" | sed -n '/^tucano-proxy$/p' | wc -l | tr -d ' ')" -eq 1 ] ||
  fail 'Archive must contain exactly one root tucano-proxy executable'
ENTRY=$(tar -tvzf "$TMP/$ASSET" tucano-proxy)
case "$ENTRY" in -*) ;; *) fail 'Executable archive member is not a regular file' ;; esac
tar -xOzf "$TMP/$ASSET" tucano-proxy > "$TMP/tucano-proxy"
[ -f "$TMP/tucano-proxy" ] && [ ! -L "$TMP/tucano-proxy" ] || fail 'Archive does not contain a regular executable'
chmod 755 "$TMP/tucano-proxy"
DOWNLOADED_VERSION=$("$TMP/tucano-proxy" --version)
case "$DOWNLOADED_VERSION" in 'tucano-proxy '[0-9]*.[0-9]*.[0-9]*) ;; *) fail 'Downloaded file is not a Tucano Proxy CLI executable' ;; esac
if [ "$VERSION" != latest ] && [ "$DOWNLOADED_VERSION" != "tucano-proxy ${VERSION#v}" ]; then
  fail 'Downloaded executable version does not match the requested release'
fi
printf '%s\n' "$DOWNLOADED_VERSION"
mkdir -p "$INSTALL_DIR"
# Stage in destination filesystem and rename atomically, preserving a running binary.
STAGED=$(mktemp "$INSTALL_DIR/.tucano-proxy.XXXXXXXX")
if ! cp "$TMP/tucano-proxy" "$STAGED" || ! chmod 755 "$STAGED" || ! mv -f "$STAGED" "$DESTINATION"; then
  rm -f "$STAGED"
  fail 'Could not install executable; check directory permissions'
fi
printf '\n%s: %s\n' "$ACTION" "$DESTINATION"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add this directory to PATH in your shell: %s\n' "$INSTALL_DIR" ;;
esac
printf '\nChecking the selected session certificate (read-only):\n'
if ! "$DESTINATION" setup --status; then
  printf 'Certificate status could not be determined. Run: %s setup --status\n' "$QUOTED_DESTINATION"
fi
printf '\nFirst-run setup: %s setup\n' "$QUOTED_DESTINATION"
printf 'Check for updates: %s update --check\n' "$QUOTED_DESTINATION"
printf 'Update this installation: %s update\n' "$QUOTED_DESTINATION"
printf 'For automation, use update --yes; normal update asks before replacement.\n'
printf 'No CA certificate, system proxy, session data, skill, or shell profile was changed by this installer.\n'
if [ "$ACTION" = Updating ]; then
  printf 'Running services keep their previous version. Stop and start each session manually when ready.\n'
fi
if [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ]; then
  printf '\nRun the first-use setup wizard now? [y/N] '
  IFS= read -r ANSWER || ANSWER=
  case "$ANSWER" in
    y|Y|yes|YES) "$DESTINATION" setup ;;
    *) printf 'You can run %s setup whenever you are ready.\n' "$QUOTED_DESTINATION" ;;
  esac
else
  printf 'Setup was not started because this installer is non-interactive. Run the setup command above in a terminal.\n'
fi
