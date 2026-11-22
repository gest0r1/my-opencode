#!/usr/bin/env python3
"""Fail-closed check that OpenChamber services have no live child processes.

A child may be an interactive PTY, an extension service, a project action or
another runtime. A human quiescence flag alone is never sufficient.
OpenCode's separate opencode-web service is intentionally not inspected or
stopped: its running agent sessions are preserved across OpenChamber cutover.
"""
import argparse
import os
import subprocess
import sys

class QuiescenceError(RuntimeError):
    pass


def check(inventory, service_pids):
    """Validate ps parent graph and reject a descendant of either UI service."""
    rows = {}
    for line in inventory.splitlines():
        columns = line.strip().split(None, 2)
        if len(columns) != 3:
            raise QuiescenceError('PROCESS_INVENTORY_MALFORMED')
        try:
            pid, parent, uid = map(int, columns)
        except ValueError:
            raise QuiescenceError('PROCESS_INVENTORY_MALFORMED') from None
        if pid < 1 or parent < 0 or uid < 0 or pid in rows:
            raise QuiescenceError('PROCESS_INVENTORY_INVALID')
        rows[pid] = (parent, uid)
    if not rows:
        raise QuiescenceError('PROCESS_INVENTORY_EMPTY')
    for pid, expected_uid in service_pids:
        if pid <= 1:
            continue
        if pid not in rows or rows[pid][1] != expected_uid:
            raise QuiescenceError('SERVICE_PID_UNTRUSTED')
        for candidate in rows:
            if candidate == pid:
                continue
            parent = rows[candidate][0]
            seen = set()
            while parent > 1:
                if parent == pid:
                    raise QuiescenceError(f'LIVE_OPENCHAMBER_CHILD pid={candidate} parent={pid}')
                if parent in seen:
                    raise QuiescenceError('PROCESS_INVENTORY_CYCLE')
                seen.add(parent)
                # Missing ancestor indicates an incomplete snapshot: never
                # interpret it as quiescence.
                if parent not in rows:
                    raise QuiescenceError('PROCESS_INVENTORY_INCOMPLETE')
                parent = rows[parent][0]
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--old-pid', required=True, type=int)
    p.add_argument('--old-uid', required=True, type=int)
    p.add_argument('--root-pid', required=True, type=int)
    opts = p.parse_args()
    output = subprocess.run(['ps', '-eo', 'pid=,ppid=,uid='], check=True,
                            capture_output=True, text=True).stdout
    if check(output, [(opts.old_pid, opts.old_uid), (opts.root_pid, 0)]):
        print('OPENCHAMBER_SERVICES_QUIESCENT')


if __name__ == '__main__':
    try:
        main()
    except (QuiescenceError, subprocess.SubprocessError) as e:
        print('OPENCHAMBER_QUIESCENCE_BLOCKED: ' + str(e), file=sys.stderr)
        sys.exit(2)
