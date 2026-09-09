#!/usr/bin/env python3
"""Generate Homebrew and WinGet manifests from checksum-verified release archives."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tomllib


REPOSITORY = 'https://github.com/plscabral/tucano-proxy'
IDENTIFIER = 'PauloCabral.TucanoProxy.CLI'
SCHEMA_VERSION = '1.10.0'
TARGETS = (
    'aarch64-apple-darwin', 'x86_64-apple-darwin',
    'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
)


def release_version(value):
    if value is None:
        cargo = Path(__file__).resolve().parent.parent / 'crates/tucano-cli/Cargo.toml'
        with cargo.open('rb') as stream:
            value = tomllib.load(stream)['package']['version']
    if not re.fullmatch(
        r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
        r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
        r'(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value
    ) or len(value) > 128:
        raise ValueError('version must be a SemVer without a leading v')
    prerelease = value.split('+', 1)[0].partition('-')[2]
    if any(part.isdigit() and len(part) > 1 and part.startswith('0')
           for part in prerelease.split('.')):
        raise ValueError('numeric prerelease identifiers cannot have leading zeroes')
    return value


def verified_archives(directory, version):
    archives = {}
    for target in TARGETS:
        extension = 'zip' if target.endswith('windows-msvc') else 'tar.gz'
        name = f'tucano-proxy-{target}.{extension}'
        archive = directory / name
        checksum = directory / (name + '.sha256')
        expected = checksum.read_text(encoding='ascii').strip()
        match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *]' + re.escape(name), expected)
        if not match:
            raise ValueError(f'invalid checksum file (expected hash and exact filename): {checksum}')
        with archive.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != match[1].lower():
            raise ValueError(f'checksum mismatch: {archive}')
        archives[target] = (f'{REPOSITORY}/releases/download/v{version}/{name}', actual)
    return archives


def formula(version, archives):
    lines = [
        'class TucanoProxy < Formula',
        '  desc "Local HTTP(S) inspection for terminals, browsers and coding agents"',
        f'  homepage "{REPOSITORY}"',
        f'  version "{version}"',
        '  license "MIT"',
        '',
    ]
    for system, suffix in (('macos', 'apple-darwin'), ('linux', 'unknown-linux-gnu')):
        lines.append(f'  on_{system} do')
        for cpu, arch in (('arm', 'aarch64'), ('intel', 'x86_64')):
            url, checksum = archives[f'{arch}-{suffix}']
            lines.extend([
                f'    on_{cpu} do',
                f'      url "{url}"',
                f'      sha256 "{checksum}"',
                '    end',
            ])
        lines.extend(['  end', ''])
    lines.extend([
        '  def install',
        '    bin.install "tucano-proxy"',
        '    (bin/".tucano-proxy-install.json").write \'{"channel":"homebrew","package":"plscabral/tap/tucano-proxy"}\'',
        '    generate_completions_from_executable(bin/"tucano-proxy", "completions")',
        '  end',
        '',
        '  test do',
        '    assert_equal "tucano-proxy #{version}", shell_output("#{bin}/tucano-proxy --version").strip',
        '  end',
        'end',
        '',
    ])
    return '\n'.join(lines)


def manifest(kind, version, body):
    # JSON-quoted scalar strings are valid YAML and avoid implicit YAML typing.
    schema = kind.lower()
    return (
        '# Created by scripts/package-managers.py\n'
        f'# yaml-language-server: $schema=https://aka.ms/winget-manifest.{schema}.{SCHEMA_VERSION}.schema.json\n\n'
        f'PackageIdentifier: {IDENTIFIER}\n'
        f'PackageVersion: {json.dumps(version)}\n'
        f'{body}'
        f'ManifestType: {kind}\n'
        f'ManifestVersion: {SCHEMA_VERSION}\n'
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--version', help='default: CLI Cargo.toml package version')
    args = parser.parse_args()
    try:
        version = release_version(args.version)
        archives = verified_archives(args.artifacts, version)
        url, checksum = archives['x86_64-pc-windows-msvc']
        destination = args.output / f'manifests/p/PauloCabral/TucanoProxy/CLI/{version}'
        files = {
            args.output / 'Formula/tucano-proxy.rb': formula(version, archives),
            destination / f'{IDENTIFIER}.yaml': manifest('version', version, 'DefaultLocale: en-US\n'),
            destination / f'{IDENTIFIER}.installer.yaml': manifest('installer', version, (
                'InstallerType: zip\n'
                'NestedInstallerType: portable\n'
                'NestedInstallerFiles:\n'
                '- RelativeFilePath: tucano-proxy.exe\n'
                '  PortableCommandAlias: tucano-proxy\n'
                'UpgradeBehavior: uninstallPrevious\n'
                'Commands:\n'
                '- tucano-proxy\n'
                'Installers:\n'
                '- Architecture: x64\n'
                f'  InstallerUrl: {url}\n'
                f'  InstallerSha256: {checksum.upper()}\n'
            )),
            destination / f'{IDENTIFIER}.locale.en-US.yaml': manifest('defaultLocale', version, (
                'PackageLocale: en-US\n'
                'Publisher: Paulo Cabral\n'
                'PublisherUrl: https://github.com/plscabral\n'
                f'PublisherSupportUrl: {REPOSITORY}/issues\n'
                'Author: Paulo Cabral\n'
                'PackageName: Tucano Proxy CLI\n'
                f'PackageUrl: {REPOSITORY}\n'
                'License: MIT\n'
                f'LicenseUrl: {REPOSITORY}/blob/v{version}/LICENSE\n'
                'Copyright: Copyright (c) 2026 Paulo Cabral\n'
                'ShortDescription: Local HTTP(S) inspection for terminals, browsers and coding agents.\n'
                'Description: |-\n'
                '  Standalone native HTTP(S) inspection proxy with a terminal UI, local web\n'
                '  inspector, named sessions, request replay and coding-agent integrations.\n'
                '  This package installs the command-line application, not the desktop app.\n'
                'Moniker: tucano-proxy\n'
                'Tags:\n'
                '- cli\n'
                '- developer-tools\n'
                '- http\n'
                '- https\n'
                '- proxy\n'
                '- tui\n'
                f'ReleaseNotesUrl: {REPOSITORY}/releases/tag/v{version}\n'
            )),
        }
        for path, content in files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8', newline='\n')
            print(path)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
