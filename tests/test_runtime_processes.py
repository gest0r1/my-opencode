#!/usr/bin/env python3
"""Permanent tests for embedded-terminal/runtime process detection."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("runtime_processes", ROOT / "scripts/runtime-processes.py")
processes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(processes)


class RuntimeProcessTests(unittest.TestCase):
    def test_inventory_and_embedded_terminal_detection(self):
        rows = processes.inventory('''1 0 0 /sbin/init
2 1 1001 /usr/lib/systemd/systemd --user
3 2 1001 (sd-pam)
4 2 1001 dbus-daemon --session
5 2 1001 /home/opencode/.opencode/bin/opencode serve --stdio --port 0
6 2 1001 node /home/opencode/.local/share/openchamber/server/index.js
7 2 0 bash -c 'cat /home/opencode/.opencode/bin/opencode serve'
8 2 0 node /root/.local/share/openchamber-v2/current/bin/openchamber serve --host 0.0.0.0 --port 3000 --foreground
9 8 1001 bash
10 9 0 sudo bash
11 1 1001 node /var/lib/my-openchamber/runtime/current/install/global/node_modules/@openchamber/web/build/bin/cli.js serve --foreground
12 11 1001 bash
13 12 0 sudo bash
''')
        self.assertEqual([r['pid'] for r in rows if r['runtime']], [5, 6, 8, 11])
        self.assertTrue(processes.embedded(rows, 5))
        self.assertFalse(processes.embedded(rows, 7))
        self.assertTrue(processes.embedded(rows, 10))
        self.assertTrue(processes.embedded(rows, 13))
        for invalid in ('', 'malformed', '1 2 uid command'):
            with self.assertRaises(ValueError):
                processes.inventory(invalid)
        with self.assertRaises(ValueError):
            processes.embedded(rows, 99)

    def test_ps_failure_is_not_empty_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            ps = Path(tmp) / 'ps'
            ps.write_text('#!/bin/sh\nexit 42\n')
            ps.chmod(0o755)
            result = subprocess.run(
                ['python3', str(ROOT / 'scripts/runtime-processes.py'), '--uid', '0', '--require-stopped'],
                env={**os.environ, 'PATH': tmp + ':' + os.environ['PATH']},
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
