#!/usr/bin/env python3
"""Package a built native CLI and its documentation without runtime dependencies."""
import argparse
import hashlib
import io
import os
from pathlib import Path
import tarfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--target', required=True)
    parser.add_argument('--output', default=Path('release'), type=Path)
    args = parser.parse_args()
    targets = {
        'aarch64-apple-darwin', 'x86_64-apple-darwin',
        'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu',
        'x86_64-pc-windows-msvc',
    }
    if args.target not in targets:
        parser.error('unsupported release target')
    root = Path(__file__).resolve().parent.parent
    windows = args.target.endswith('windows-msvc')
    files = {
        'tucano-proxy.exe' if windows else 'tucano-proxy': args.binary,
        'LICENSE': root / 'LICENSE',
        'README.md': root / 'README.md',
        'docs/cli.md': root / 'docs/cli.md',
        'docs/architecture.md': root / 'docs/architecture.md',
        'docs/security.md': root / 'docs/security.md',
        'public/tucano-proxy.png': root / 'public/tucano-proxy.png',
        'skills/tucano-proxy/SKILL.md': root / 'skills/tucano-proxy/SKILL.md',
    }
    for source in files.values():
        if not source.is_file():
            parser.error(f'missing release input: {source}')
    args.output.mkdir(parents=True, exist_ok=True)
    extension = 'zip' if windows else 'tar.gz'
    destination = args.output / f'tucano-proxy-{args.target}.{extension}'
    if windows:
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, source in files.items():
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o755 if name == 'tucano-proxy.exe' else 0o644) << 16
                archive.writestr(info, source.read_bytes())
    else:
        # gzip timestamp is fixed so repeated packaging of identical inputs is reproducible.
        import gzip
        with destination.open('wb') as raw:
            with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    for name, source in files.items():
                        data = source.read_bytes()
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        info.mode = 0o755 if name == 'tucano-proxy' else 0o644
                        info.mtime = int(os.environ.get('SOURCE_DATE_EPOCH', '0'))
                        archive.addfile(info, io.BytesIO(data))
    with destination.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    checksum = destination.with_name(destination.name + '.sha256')
    checksum.write_text(f'{digest}  {destination.name}\n', encoding='ascii')
    print(destination)
    print(checksum)


if __name__ == '__main__':
    main()
