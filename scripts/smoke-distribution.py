#!/usr/bin/env python3
"""Exercise real native and npm binaries without touching the user's installation."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--target', required=True)
parser.add_argument('--artifacts', type=Path, default=Path('release'))
args = parser.parse_args()
platforms = json.loads((root / 'npm/platforms.json').read_text())
platform = next(p for p in platforms.values() if p['target'] == args.target)
with (root / 'crates/tucano-cli/Cargo.toml').open('rb') as stream:
    version = tomllib.load(stream)['package']['version']
packages = args.artifacts.resolve() / 'npm'
npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
node = shutil.which('node')
if not npm or not node:
    raise SystemExit('Node and npm are required for distribution verification')


def run(command, expected=0, **kwargs):
    result = subprocess.run(command, text=True, capture_output=True, timeout=90, **kwargs)
    if result.returncode != expected:
        raise RuntimeError(f'{command[0]} exited {result.returncode}: {result.stdout}\n{result.stderr}')
    return result.stdout


with tempfile.TemporaryDirectory(prefix='tucano-distribution-') as directory:
    temp = Path(directory)
    # Pack, inspect and install the artifacts consumers receive, not source symlinks.
    tarballs = []
    for name in (platform['name'], 'tucano-proxy'):
        packed = json.loads(run([npm, 'pack', str(packages / name), '--pack-destination', str(temp), '--json']))[0]
        files = {entry['path']: entry for entry in packed['files']}
        if name == platform['name']:
            if 'bin/.tucano-proxy-install.json' not in files:
                raise RuntimeError('npm omitted native installation ownership marker')
            # npm packs whatever mode it finds, and CI artifact transport drops
            # permission bits: a 0644 binary installs and then cannot be spawned.
            entry = files.get('bin/' + platform['executable'])
            if entry is None:
                raise RuntimeError('npm omitted the native executable')
            if platform['os'] != 'win32' and not entry.get('mode', 0) & 0o111:
                raise RuntimeError(f"packed executable is not executable: mode {entry.get('mode')}")
        tarballs.append(str(temp / packed['filename']))
    prefix = temp / 'installed'
    run([npm, 'install', '--prefix', str(prefix), '--ignore-scripts', '--no-audit', '--no-fund',
         '--omit=optional', *tarballs])
    launcher = prefix / 'node_modules/tucano-proxy/bin/launcher.cjs'
    command = [node, str(launcher)]
    assert run([*command, '--version']).strip() == f'tucano-proxy {version}'
    assert 'setup' in run([*command, '--help'])
    run([*command, '--invalid-option'], expected=2)
    isolated = temp / 'untouched-session'
    env = {**os.environ, 'TUCANO_DATA_DIR': str(isolated)}
    response = json.loads(run([*command, 'update', '--yes', '--json'], expected=7, env=env))
    assert response['error']['code'] == 'managed_installation', response
    assert 'npm install' in response['error']['message'], response
    assert not isolated.exists(), 'Managed update changed session files'
    # Native distribution remains standalone; remove the npm-only marker from a private copy.
    native = temp / platform['executable']
    shutil.copy2(prefix / 'node_modules' / platform['name'] / 'bin' / platform['executable'], native)
    assert run([str(native), '--version']).strip() == f'tucano-proxy {version}'
    for shell in ('bash', 'zsh', 'fish'):
        assert 'tucano' in run([str(native), 'completions', shell])
    run([npm, 'uninstall', '--prefix', str(prefix), '--ignore-scripts', '--no-audit', '--no-fund',
         'tucano-proxy', platform['name']])
    assert not launcher.exists(), 'npm uninstall left its launcher installed'
print(f'Verified native and packed npm installation, exit codes, managed update and uninstall: {args.target}')
