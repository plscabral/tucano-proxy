#!/usr/bin/env python3
"""Package reviewed installers, skill, npm tarballs and native package manifests."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts', type=Path, default=Path('release'))
args = parser.parse_args()
artifacts = args.artifacts.resolve()
for name in ('install.sh', 'install.ps1'):
    shutil.copyfile(root / 'scripts' / name, artifacts / name)
with zipfile.ZipFile(artifacts / 'tucano-proxy-skill.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(root / 'skills/tucano-proxy/SKILL.md', 'skills/tucano-proxy/SKILL.md')
    archive.write(root / 'LICENSE', 'LICENSE')
with zipfile.ZipFile(artifacts / 'tucano-proxy-package-managers.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    directory = artifacts / 'package-managers'
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(directory).as_posix())
platforms = json.loads((root / 'npm/platforms.json').read_text())
npm = shutil.which('npm.cmd') or shutil.which('npm')
if not npm:
    raise SystemExit('npm is required to pack distribution packages')
for name in [p['name'] for p in platforms.values()] + ['tucano-proxy']:
    subprocess.run([npm, 'pack', str(artifacts / 'npm' / name), '--pack-destination', str(artifacts)], check=True)
for path in sorted(artifacts.iterdir()):
    if path.is_file() and not path.name.endswith('.sha256'):
        with path.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        path.with_name(path.name + '.sha256').write_text(f'{checksum}  {path.name}\n', encoding='ascii')
        print(path.name)
