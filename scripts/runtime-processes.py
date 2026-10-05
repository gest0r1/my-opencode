#!/usr/bin/env python3
"""Fail-closed runtime inventory. Never kill a process from a name substring."""
import argparse
import json
import re
import shlex
from pathlib import Path
import subprocess


def inventory(text):
    rows = []
    if not text.strip():
        raise ValueError('empty process inventory')
    for line in text.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) != 4 or not all(v.isdigit() for v in fields[:3]):
            raise ValueError('malformed process inventory')
        pid, ppid, uid = map(int, fields[:3])
        args = fields[3]
        # Match executable/path + runtime mode, not arbitrary diagnostic commands.
        try:
            tokens = shlex.split(args)
        except ValueError:
            # ps args is a display string, not a shell-escaped argv. An unrelated
            # process may legitimately contain unmatched quote characters.
            tokens = args.split()
        executable = Path(tokens[0]).name if tokens else ''
        runtime = executable in ('opencode', 'openchamber') and any(t in ('serve', 'web', 'start') for t in tokens[1:])
        if executable in ('node', 'bun', 'python3', 'python'):
            runtime = runtime or any(re.search(r'(?:openchamber|packages/web)/(?:server/|bin/cli)', t)
                                     or re.search(r'/(?:extensions|server-browser)/.+\.(?:js|mjs|py)$', t)
                                     for t in tokens[1:] if not t.startswith('-'))
        rows.append(dict(pid=pid, ppid=ppid, uid=uid, runtime=runtime))
    return rows


def collect():
    result = subprocess.run(['ps', '-eo', 'pid=,ppid=,uid=,args='],
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('ps inventory failed exit=' + str(result.returncode) + ': ' + result.stderr[:200])
    return inventory(result.stdout)


def embedded(rows, pid):
    by_pid = {row['pid']: row for row in rows}
    seen = set()
    while pid > 1:
        if pid in seen or pid not in by_pid:
            raise ValueError('incomplete/cyclic ancestor inventory')
        seen.add(pid)
        row = by_pid[pid]
        if row['runtime']:
            return True
        pid = row['ppid']
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uid', type=int)
    parser.add_argument('--require-stopped', action='store_true')
    parser.add_argument('--ancestor', type=int)
    opts = parser.parse_args()
    rows = collect()
    if opts.ancestor is not None:
        print('embedded' if embedded(rows, opts.ancestor) else 'external')
        return
    runtime = [r for r in rows if r['runtime'] and (opts.uid is None or r['uid'] == opts.uid)]
    print(json.dumps(runtime))
    if opts.require_stopped and runtime:
        raise SystemExit('Runtime processes are still active; cutover refused')


if __name__ == '__main__':
    main()
