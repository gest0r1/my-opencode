#!/usr/bin/env python3
"""Collect historical literal credentials for local git-filter-repo. Never print values."""
import os
import re
import subprocess
import sys
import tempfile

FIELDS = (b'X-API-Key', b'ITOP_TOKEN', b'GDRIVE_MCP_CLIENT_ID', b'GDRIVE_MCP_CLIENT_SECRET', b'GDRIVE_MCP_REFRESH_TOKEN')
PATTERN = re.compile(rb'"(' + b'|'.join(re.escape(field) for field in FIELDS) + rb')"\s*:\s*"([^"\r\n]+)"')

def main():
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        raise ValueError('Usage: build-history-replacements.py ABSOLUTE_PRIVATE_OUTPUT_FILE')
    file = os.path.realpath(sys.argv[1])
    gitdir = os.path.realpath(subprocess.check_output(['git', 'rev-parse', '--absolute-git-dir'], text=True).strip())
    if file == gitdir or file.startswith(gitdir + os.sep): raise ValueError('Output cannot reside in Git data')
    if os.path.exists(file): raise ValueError('Refuse to overwrite existing replacement file')
    ids = sorted(set(subprocess.check_output(['git', 'rev-list', '--all', '--objects', '--no-object-names'], text=True).splitlines()))
    found = set()
    with tempfile.TemporaryFile() as requests:
        for oid in ids: requests.write(oid.encode() + b'\n')
        requests.seek(0)
        proc = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=requests, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for _ in ids:
                header = proc.stdout.readline().split()
                if len(header) != 3: raise RuntimeError('Invalid git object header')
                kind, size = header[1], int(header[2])
                if size > 32_000_000: raise RuntimeError('Oversized object: manual audit required')
                data = proc.stdout.read(size)
                if len(data) != size or proc.stdout.read(1) != b'\n': raise RuntimeError('Truncated Git object')
                if kind != b'blob': continue
                for _, value in PATTERN.findall(data):
                    if len(value) < 10 or value.startswith((b'{env:', b'$' + b'{', b'YOUR_', b'<')): continue
                    if b'==>' in value: raise RuntimeError('Unsupported delimiter: manual audit required')
                    found.add(value)
            if proc.wait(timeout=30): raise RuntimeError('git cat-file error')
        finally:
            if proc.poll() is None: proc.kill()
    if not found: raise RuntimeError('No literals found; audit before rewrite')
    fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            for value in sorted(found): out.write(b'literal:' + value + b'==>x\n')
    except BaseException:
        os.unlink(file)
        raise
    print('Prepared private replacements for ' + str(len(found)) + ' distinct literal values; none printed.')

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print('HISTORY_REPLACEMENTS_FAILED: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(2)
