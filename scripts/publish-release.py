#!/usr/bin/env python3
"""Attach a complete distribution to its draft; publish only with --publish."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

REPOSITORY = 'plscabral/tucano-proxy'
root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts', type=Path, default=Path('release'))
parser.add_argument('--publish', action='store_true', help='make the complete draft public')
args = parser.parse_args()
with (root / 'crates/tucano-cli/Cargo.toml').open('rb') as stream:
    version = tomllib.load(stream)['package']['version']
tag = f'v{version}'
ref = os.environ.get('GITHUB_REF', '')
if ref.startswith('refs/tags/') and ref != f'refs/tags/{tag}':
    raise SystemExit('Workflow tag disagrees with CLI version')
platforms = json.loads((root / 'npm/platforms.json').read_text())
names = ['install.sh', 'install.ps1', 'tucano-proxy-skill.zip', 'tucano-proxy-package-managers.zip',
         f'tucano-proxy-{version}.tgz']
for platform in platforms.values():
    extension = 'zip' if platform['os'] == 'win32' else 'tar.gz'
    names.extend((f"tucano-proxy-{platform['target']}.{extension}", f"{platform['name']}-{version}.tgz"))
files = []
for name in names:
    path = args.artifacts / name
    checksum_path = path.with_name(name + '.sha256')
    match = re.fullmatch(r'([a-f0-9]{64})  ' + re.escape(name) + r'\n?', checksum_path.read_text(encoding='ascii'))
    if not match:
        raise SystemExit(f'Invalid checksum: {checksum_path}')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != match[1]:
            raise SystemExit(f'Checksum mismatch: {name}')
    files.extend((str(path), str(checksum_path)))


def view():
    return subprocess.run(['gh', 'release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft,url'],
                          capture_output=True, text=True, timeout=30)


release = view()
if release.returncode:
    # Another independently running desktop job may create the same draft first.
    created = subprocess.run(['gh', 'release', 'create', tag, '--repo', REPOSITORY, '--draft',
                              '--verify-tag', '--title', f'Tucano Proxy {tag}', '--notes',
                              'Standalone CLI, terminal and web inspectors; native installers, npm packages, Homebrew/WinGet manifests and agent skill.'])
    release = view()
    if release.returncode:
        raise SystemExit(release.stderr or 'Release draft could not be created')
metadata = json.loads(release.stdout)
if not metadata['isDraft']:
    raise SystemExit('Release is already public; refusing to replace immutable distribution assets')
subprocess.run(['gh', 'release', 'upload', tag, '--repo', REPOSITORY, '--clobber', *files], check=True)
if args.publish:
    subprocess.run(['gh', 'release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest'], check=True)
print(metadata['url'])
