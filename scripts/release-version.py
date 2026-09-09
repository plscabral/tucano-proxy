#!/usr/bin/env python3
"""Fail a release before building if product metadata or the tag disagrees."""
import json
import os
from pathlib import Path
import re
import tomllib

root = Path(__file__).resolve().parent.parent
versions = {}
for path in ('crates/tucano-cli/Cargo.toml', 'crates/tucano-core/Cargo.toml',
             'crates/tucano-service/Cargo.toml', 'src-tauri/Cargo.toml'):
    with (root / path).open('rb') as stream:
        versions[path] = tomllib.load(stream)['package']['version']
for path in ('package.json', 'src-tauri/tauri.conf.json'):
    versions[path] = json.loads((root / path).read_text())['version']
version = versions['crates/tucano-cli/Cargo.toml']
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
    raise SystemExit('Stable distribution requires a numeric MAJOR.MINOR.PATCH version')
if any(value != version for value in versions.values()):
    raise SystemExit(f'Inconsistent product versions: {versions}')
ref = os.environ.get('GITHUB_REF', '')
if ref.startswith('refs/tags/') and ref != f'refs/tags/v{version}':
    raise SystemExit(f'Tag {ref} does not match product version {version}')
print(f'Validated Tucano Proxy v{version}')
