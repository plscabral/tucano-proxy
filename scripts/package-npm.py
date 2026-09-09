#!/usr/bin/env python3
"""Generate npm packages from checksummed native release archives (Python 3.11+)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile
import tomllib
import zipfile


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def extract_binary(artifacts, platform, destination):
    """Verify and read the same open archive; never extract archive paths."""
    windows = platform['os'] == 'win32'
    extension = 'zip' if windows else 'tar.gz'
    archive_path = artifacts / f"tucano-proxy-{platform['target']}.{extension}"
    checksum_path = archive_path.with_name(archive_path.name + '.sha256')
    checksum = checksum_path.read_text(encoding='ascii')
    match = re.fullmatch(
        r'([0-9a-fA-F]{64}) [ *]' + re.escape(archive_path.name) + r'\r?\n?',
        checksum,
    )
    if match is None:
        raise ValueError(f'invalid checksum file (expected one SHA-256 and exact archive name): {checksum_path}')
    expected_name = platform['executable']
    with archive_path.open('rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError(f'archive must be a regular file: {archive_path}')
        actual = hashlib.file_digest(source, 'sha256').hexdigest()
        if actual != match[1].lower():
            raise ValueError(f'SHA-256 mismatch: {archive_path}')
        source.seek(0)
        if windows:
            with zipfile.ZipFile(source) as archive:
                matches = [entry for entry in archive.infolist() if entry.filename == expected_name]
                if len(matches) != 1:
                    raise ValueError(f'{archive_path}: expected exactly one root {expected_name} entry')
                entry = matches[0]
                # package-release.py writes permission bits without S_IFREG.
                # Zero type bits denote a normal ZIP file; links/devices do not.
                file_type = stat.S_IFMT(entry.external_attr >> 16)
                if entry.is_dir() or file_type not in (0, stat.S_IFREG) or entry.external_attr & 0x10 or entry.file_size == 0:
                    raise ValueError(f'{archive_path}: {expected_name} must be a nonempty regular file')
                with archive.open(entry) as binary, destination.open('wb') as output:
                    shutil.copyfileobj(binary, output)
        else:
            with tarfile.open(fileobj=source, mode='r:gz') as archive:
                matches = [entry for entry in archive.getmembers() if entry.name == expected_name]
                if len(matches) != 1:
                    raise ValueError(f'{archive_path}: expected exactly one root {expected_name} entry')
                entry = matches[0]
                if not entry.isfile() or entry.size == 0:
                    raise ValueError(f'{archive_path}: {expected_name} must be a nonempty regular file')
                with archive.extractfile(entry) as binary, destination.open('wb') as output:
                    shutil.copyfileobj(binary, output)
    destination.chmod(0o755)


def generate(root, artifacts, output, selected, platforms, version):
    metadata = json.loads((root / 'npm/package.json').read_text(encoding='utf-8'))
    metadata['version'] = version
    metadata['optionalDependencies'] = {
        platform['name']: version for platform in platforms.values()
    }
    output.mkdir(parents=True, exist_ok=True)
    names = [metadata['name']] + [platform['name'] for platform in selected]
    # Stage every selected archive before changing any publishable package.
    with tempfile.TemporaryDirectory(prefix='.package-npm-', dir=output) as temporary:
        staging = Path(temporary)
        main = staging / metadata['name']
        (main / 'bin').mkdir(parents=True)
        write_json(main / 'package.json', metadata)
        shutil.copyfile(root / 'npm/bin/launcher.cjs', main / 'bin/launcher.cjs')
        (main / 'bin/launcher.cjs').chmod(0o755)
        shutil.copyfile(root / 'npm/platforms.json', main / 'platforms.json')
        shutil.copyfile(root / 'LICENSE', main / 'LICENSE')
        for platform in selected:
            package = staging / platform['name']
            binary_dir = package / 'bin'
            binary_dir.mkdir(parents=True)
            extract_binary(artifacts, platform, binary_dir / platform['executable'])
            native_metadata = {
                key: metadata[key]
                for key in ('author', 'license', 'homepage', 'repository', 'bugs', 'publishConfig')
            }
            native_metadata.update({
                'name': platform['name'],
                'version': version,
                'description': f"Native Tucano Proxy CLI for {platform['target']} (installed by tucano-proxy).",
                'os': [platform['os']],
                'cpu': [platform['cpu']],
                'files': [f"bin/{platform['executable']}", 'bin/.tucano-proxy-install.json', 'LICENSE'],
            })
            if 'libc' in platform:
                native_metadata['libc'] = [platform['libc']]
            write_json(package / 'package.json', native_metadata)
            write_json(binary_dir / '.tucano-proxy-install.json', {
                'channel': 'npm',
                'package': 'tucano-proxy',
            })
            shutil.copyfile(root / 'LICENSE', package / 'LICENSE')
        for name in names:
            destination = output / name
            # Only generated files are overwritten. Explicit npm "files" lists
            # keep unrelated/stale files out of the published package payload.
            shutil.copytree(staging / name, destination, dirs_exist_ok=True)
    return [output / name for name in names]


def main():
    root = Path(__file__).resolve().parent.parent
    platforms = json.loads((root / 'npm/platforms.json').read_text(encoding='utf-8'))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=Path('release'), help='directory containing native archives and adjacent .sha256 files (default: release)')
    parser.add_argument('--output', type=Path, default=Path('release/npm'), help='destination for unpacked publishable npm packages (default: release/npm)')
    parser.add_argument('--target', choices=[platform['target'] for platform in platforms.values()], help='generate the main package and only this native target for local smoke use; omit for all five release targets')
    args = parser.parse_args()
    try:
        with (root / 'crates/tucano-cli/Cargo.toml').open('rb') as manifest:
            version = tomllib.load(manifest)['package']['version']
        selected = [platform for platform in platforms.values() if args.target is None or platform['target'] == args.target]
        for package in generate(root, args.artifacts, args.output, selected, platforms, version):
            print(package)
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile, RuntimeError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
