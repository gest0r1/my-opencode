#!/usr/bin/env python3
"""Regression coverage for split-user OpenChamber Chats directory."""
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / 'scripts/install-openchamber-root.sh').read_text()
UNIT = (ROOT / 'config/systemd/openchamber-root.service').read_text()
MATCH = re.search(
    r'run_oc_user python3 - "\$SHARED_CHATS_DIR" <<\x27PY\x27\n(.*?)\nPY\n',
    INSTALLER, re.DOTALL,
)
assert MATCH, 'shared Chats setup missing from canonical installer'
PREPARE = MATCH.group(1)


def run_setup(home):
    path = home / '.config/openchamber/chats'
    env = {**os.environ, 'HOME': str(home)}
    return subprocess.run(
        [sys.executable, '-', str(path)], input=PREPARE,
        text=True, capture_output=True, env=env, timeout=10,
    )


class SharedChatsContract(unittest.TestCase):
    def test_new_chats_and_existing_dates_are_group_writable(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            target = home / '.config/openchamber/chats'
            existing = target / '2026-11-21' / 'session-legacy'
            existing.mkdir(parents=True)
            marker = existing / 'test.txt'
            marker.write_text('preserved')
            result = run_setup(home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(marker.read_text(), 'preserved')
            for directory in (target, existing.parent, existing):
                mode = os.stat(directory).st_mode
                self.assertTrue(mode & stat.S_ISGID, str(directory))
                self.assertEqual(stat.S_IMODE(mode) & 0o770, 0o770)
                self.assertEqual(stat.S_IMODE(mode) & 0o007, 0)
            self.assertEqual(run_setup(home).returncode, 0)

    def test_refuses_symlinks_without_following_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            legacy = home / '.config/openchamber'
            legacy.mkdir(parents=True)
            unrelated = Path(tmp) / 'unrelated'
            unrelated.mkdir()
            (legacy / 'chats').symlink_to(unrelated, target_is_directory=True)
            result = run_setup(home)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('SYMLINK_REFUSED', result.stderr)
            self.assertEqual(stat.S_IMODE(unrelated.stat().st_mode), 0o755)

    def test_refuses_nested_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            chats = home / '.config/openchamber/chats'
            chats.mkdir(parents=True)
            (chats / 'unsafe').symlink_to(Path(tmp), target_is_directory=True)
            result = run_setup(home)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ENTRY_SYMLINK_REFUSED', result.stderr)

    def test_root_service_env_and_isolation(self):
        self.assertIn('UMask=0002', UNIT)
        trusted = 'EnvironmentFile=/etc/my-opencode/openchamber-execution.env'
        migrated = 'EnvironmentFile=-/root/.config/openchamber/startup.env'
        self.assertLess(UNIT.index(migrated), UNIT.index(trusted))
        self.assertIn('OPENCHAMBER_CHATS_DIR=%s', INSTALLER)
        self.assertIn('run_oc_user python3 - "$SHARED_CHATS_DIR"', INSTALLER)
        self.assertIn('OPENCHAMBER_EXECUTION_UID=%s', INSTALLER)
        self.assertIn('OPENCHAMBER_EXECUTION_GID=%s', INSTALLER)
        self.assertIn('OPENCHAMBER_DATA_DIR=/root/.config/openchamber', INSTALLER)
        self.assertIn('NODE_OPTIONS="--require /usr/local/lib/my-opencode/openchamber-child-boundary.cjs"', INSTALLER)
        self.assertIn('OPENCODE_SKIP_START=true', INSTALLER)
        self.assertNotIn('chmod -R 777', INSTALLER)


if __name__ == '__main__':
    unittest.main()
