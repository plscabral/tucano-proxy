#!/usr/bin/env python3
"""Publish exact-version native packages first, then the npm launcher."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--packages', type=Path, default=Path('release/npm'))
parser.add_argument('--provenance', action='store_true', help='request npm provenance in a supported CI environment')
args = parser.parse_args()
npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
if not npm:
    raise SystemExit('npm is required')
main = json.loads((args.packages / 'tucano-proxy/package.json').read_text())
platforms = json.loads((root / 'npm/platforms.json').read_text())
names = [platform['name'] for platform in platforms.values()] + ['tucano-proxy']
for name in names:
    package = args.packages / name
    metadata = json.loads((package / 'package.json').read_text())
    if metadata['name'] != name or metadata['version'] != main['version']:
        raise SystemExit(f'Package identity/version mismatch: {package}')
    if name != 'tucano-proxy' and main['optionalDependencies'].get(name) != metadata['version']:
        raise SystemExit(f'Launcher dependency does not pin {name}')


def restore_executable(package, platform):
    """CI artifact transport drops POSIX permission bits, and npm packs whatever
    mode it finds: a 0644 binary installs and then fails to spawn. Restore the
    bit here, at the only place that hands packages to the registry."""
    if platform is None:
        return
    executable = package / 'bin' / platform['executable']
    mode = executable.stat().st_mode
    executable.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if os.name != 'nt' and not os.access(executable, os.X_OK):
        raise SystemExit(f'Native executable is not executable: {executable}')


by_name = {platform['name']: platform for platform in platforms.values()}
for name in names:
    version = f"{name}@{main['version']}"
    existing = subprocess.run([npm, 'view', version, 'version', '--json'], capture_output=True, text=True)
    if existing.returncode == 0:
        if json.loads(existing.stdout) != main['version']:
            raise SystemExit(f'Unexpected npm version response for {version}')
        print(f'Already published (not overwritten): {version}')
        continue
    try:
        error = json.loads(existing.stdout)['error']['code']
    except (ValueError, KeyError, TypeError):
        raise SystemExit(existing.stderr or 'Could not query npm registry')
    if error != 'E404':
        raise SystemExit(existing.stderr or f'npm registry returned {error}')
    restore_executable(args.packages / name, by_name.get(name))
    command = [npm, 'publish', str(args.packages / name), '--access', 'public']
    if args.provenance:
        command.append('--provenance')
    published = subprocess.run(command, capture_output=True, text=True)
    if published.returncode:
        # A concurrent run (release event plus manual dispatch) can win the race
        # for this exact version. That is the desired end state, not a failure.
        raced = 'previously staged version' in published.stderr or 'cannot publish over' in published.stderr.lower()
        print(published.stdout, end='')
        print(published.stderr, end='')
        if not raced:
            raise SystemExit(f'npm publish failed for {version}')
        print(f'Already present from a concurrent publish: {version}')
print(f"Published Tucano Proxy {main['version']} for all supported npm platforms")
