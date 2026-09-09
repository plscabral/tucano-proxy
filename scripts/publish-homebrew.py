#!/usr/bin/env python3
"""Publish only Formula/tucano-proxy.rb to an existing tap using gh authentication."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--formula', required=True, type=Path)
    parser.add_argument('--repo', default='plscabral/homebrew-tap', help='existing owner/repository')
    parser.add_argument('--branch', help='default: tap default branch')
    args = parser.parse_args()
    try:
        content = args.formula.read_bytes()
        match = re.search(rb'^  version "([0-9A-Za-z.+-]+)"$', content, re.MULTILINE)
        if not match or not content.startswith(b'class TucanoProxy < Formula\n'):
            raise ValueError('expected a generated TucanoProxy formula with an explicit version')
        version = match[1].decode('ascii')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
            raise ValueError('--repo must be owner/repository')
        repository = api(f'repos/{args.repo}')
        branch = args.branch or repository['default_branch']
        endpoint = f'repos/{args.repo}/contents/Formula/tucano-proxy.rb'
        existing = api(f'{endpoint}?ref={quote(branch, safe="")}', missing_ok=True)
        if existing is not None:
            if existing.get('type') != 'file' or existing.get('encoding') != 'base64':
                raise ValueError('remote formula is not a regular base64-encoded file')
            if base64.b64decode(existing['content']) == content:
                print(f'{args.repo}: tucano-proxy {version} already published')
                return
        payload = {
            'message': f'tucano-proxy {version}',
            'content': base64.b64encode(content).decode('ascii'),
            'branch': branch,
        }
        if existing is not None:
            payload['sha'] = existing['sha']
        # The Contents API rejects a stale SHA instead of overwriting a concurrent edit.
        result = api(endpoint, 'PUT', payload)
        print(result['commit']['html_url'])
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
