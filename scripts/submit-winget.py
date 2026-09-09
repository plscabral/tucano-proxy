#!/usr/bin/env python3
"""Create or update a narrowly scoped WinGet PR through gh; never force-push."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import quote, urlencode


UPSTREAM = 'microsoft/winget-pkgs'
IDENTIFIER = 'PauloCabral.TucanoProxy.CLI'


def api(endpoint, method='GET', payload=None, missing_ok=False):
    command = ['gh', 'api', '--hostname', 'github.com', '--method', method, endpoint]
    if payload is not None:
        command.extend(['--input', '-'])
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, check=False)
    if result.returncode:
        if missing_ok and '(HTTP 404)' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'gh api failed')
    return json.loads(result.stdout) if result.stdout.strip() else None


def scalar(content, key):
    match = re.search(r'^' + re.escape(key) + r':\s*([^\n]+)$', content, re.MULTILINE)
    if not match:
        raise ValueError(f'missing {key} in manifest')
    value = match[1].strip()
    return json.loads(value) if value.startswith('"') else value


def manifest_files(root, version):
    relative = f'manifests/p/PauloCabral/TucanoProxy/CLI/{version}'
    files = {}
    for suffix, kind in (('.yaml', 'version'), ('.installer.yaml', 'installer'),
                         ('.locale.en-US.yaml', 'defaultLocale')):
        path = f'{relative}/{IDENTIFIER}{suffix}'
        content = (root / path).read_text(encoding='utf-8')
        if (scalar(content, 'PackageIdentifier') != IDENTIFIER
                or scalar(content, 'PackageVersion') != version
                or scalar(content, 'ManifestType') != kind):
            raise ValueError(f'wrong package, version or manifest type: {path}')
        files[path] = content
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifests', required=True, type=Path,
                        help='generator output directory, containing manifests/')
    parser.add_argument('--version', required=True)
    parser.add_argument('--fork-owner', help='default: authenticated GitHub user; may be an organization')
    args = parser.parse_args()
    try:
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', args.version):
            raise ValueError('--version must be a SemVer without a leading v')
        files = manifest_files(args.manifests, args.version)
        user = api('user')['login']
        owner = args.fork_owner or user
        if not re.fullmatch(r'[A-Za-z0-9-]+', owner) or owner.lower() == 'microsoft':
            raise ValueError('--fork-owner must name your GitHub user or organization')
        upstream = api(f'repos/{UPSTREAM}')
        base = upstream['default_branch']
        base_sha = api(f'repos/{UPSTREAM}/git/ref/heads/{quote(base, safe="")}')['object']['sha']
        # Avoid duplicate submissions after a previous PR has merged.
        published = True
        for path, content in files.items():
            remote = api(f'repos/{UPSTREAM}/contents/{quote(path)}?ref={base_sha}', missing_ok=True)
            if (remote is None or remote.get('encoding') != 'base64'
                    or base64.b64decode(remote['content']) != content.encode('utf-8')):
                published = False
                break
        if published:
            print(f'{IDENTIFIER} {args.version} already exists in {UPSTREAM}')
            return
        fork = f'{owner}/winget-pkgs'
        repository = api(f'repos/{fork}', missing_ok=True)
        if repository is None:
            payload = {} if owner.lower() == user.lower() else {'organization': owner}
            api(f'repos/{UPSTREAM}/forks', 'POST', payload)
            # GitHub creates forks asynchronously; wait for their Git objects to exist.
            for attempt in range(12):
                repository = api(f'repos/{fork}', missing_ok=True)
                ready = api(f'repos/{fork}/git/commits/{base_sha}', missing_ok=True) if repository else None
                if ready is not None:
                    break
                time.sleep(5)
            else:
                raise RuntimeError(f'fork {fork} is still being created; rerun this command shortly')
        if not repository.get('fork') or repository.get('parent', {}).get('full_name', '').lower() != UPSTREAM:
            raise ValueError(f'{fork} is not a direct fork of {UPSTREAM}; refusing to modify it')
        branch = f'tucano-proxy-{args.version}'
        branch_path = quote(branch, safe='')
        query = urlencode({'head': f'{owner}:{branch}', 'base': base, 'state': 'all', 'per_page': 100})
        pulls = api(f'repos/{UPSTREAM}/pulls?{query}')
        opened = next((pull for pull in pulls if pull['state'] == 'open'), None)
        if opened is None and pulls:
            raise RuntimeError(f'existing PR is closed; review or reopen it before resubmitting: {pulls[0]["html_url"]}')
        reference = api(f'repos/{fork}/git/ref/heads/{branch_path}', missing_ok=True)
        parent = reference['object']['sha'] if reference else base_sha
        if reference:
            comparison = api(f'repos/{UPSTREAM}/compare/{base_sha}...{parent}')
            changes = comparison.get('files', [])
            # GitHub truncates compare file lists at 300: never trust that boundary.
            if len(changes) >= 300 or any(change['filename'] not in files
                                          or change.get('previous_filename', change['filename']) not in files
                                          for change in changes):
                raise ValueError(f'{fork}:{branch} includes unrelated changes; refusing to modify or submit it')
        commit = api(f'repos/{fork}/git/commits/{parent}')
        tree = api(f'repos/{fork}/git/trees', 'POST', {
            'base_tree': commit['tree']['sha'],
            'tree': [{'path': path, 'mode': '100644', 'type': 'blob', 'content': content}
                     for path, content in files.items()],
        })
        if tree['sha'] != commit['tree']['sha']:
            created = api(f'repos/{fork}/git/commits', 'POST', {
                'message': f'{IDENTIFIER} version {args.version}',
                'tree': tree['sha'],
                'parents': [parent],
            })
            if reference:
                # A concurrent branch advance causes a non-fast-forward failure.
                api(f'repos/{fork}/git/refs/heads/{branch_path}', 'PATCH', {
                    'sha': created['sha'], 'force': False,
                })
            else:
                api(f'repos/{fork}/git/refs', 'POST', {
                    'ref': f'refs/heads/{branch}', 'sha': created['sha'],
                })
        elif not reference:
            raise RuntimeError('manifest tree is unchanged but upstream content could not be matched')
        if opened is not None:
            print(opened['html_url'])
            return
        pull = api(f'repos/{UPSTREAM}/pulls', 'POST', {
            'title': f'{IDENTIFIER} version {args.version}',
            'head': f'{owner}:{branch}',
            'base': base,
            'body': (
                f'Adds the standalone Tucano Proxy CLI {args.version} (not the desktop application).\n\n'
                f'Release: https://github.com/plscabral/tucano-proxy/releases/tag/v{args.version}\n\n'
                'The x64 portable ZIP is the same native release artifact used by the standalone installer; '
                'its SHA-256 is verified by scripts/package-managers.py before manifest generation.\n'
            ),
            'maintainer_can_modify': True,
        })
        print(pull['html_url'])
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
