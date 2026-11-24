#!/usr/bin/env python3
"""Regression coverage for split-user OpenChamber Chats directory."""
import os
from pathlib import Path
import re
import stat
import struct
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


def restrictive_default_acl(uid):
    # Linux POSIX ACL xattr: owner=rwx, named runtime user=r-x, group=r-x,
    # mask=rwx, other=r-x. chmod 2775 alone does not fix the named entry.
    entries = [(1, 7, 0xffffffff), (2, 5, uid), (4, 5, 0xffffffff),
               (16, 7, 0xffffffff), (32, 5, 0xffffffff)]
    return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *row) for row in entries)


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

    def test_root_ui_created_dates_and_sessions_survive_reinstall(self):
        # GitHub's disposable runner has sudo. Run the real installer snippet
        # as the unprivileged test user against directories owned by root.
        if os.geteuid() == 0:
            self.skipTest('requires an unprivileged test user')
        try:
            sudo = subprocess.run(['sudo', '-n', 'true'], capture_output=True)
        except FileNotFoundError:
            sudo = None
        if sudo is None or sudo.returncode:
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                self.fail('real UID regression requires sudo on hosted CI')
            self.skipTest('sudo unavailable')
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            target = home / '.config/openchamber/chats'
            target.parent.mkdir(parents=True)
            os.setxattr(target.parent, 'system.posix_acl_default',
                        restrictive_default_acl(os.geteuid()))
            target.mkdir()
            self.assertIn('system.posix_acl_default', os.listxattr(target))
            self.assertIn('system.posix_acl_access', os.listxattr(target))
            # Prove failure before setup using a genuinely root-created child.
            denied = target / 'before-normalization'
            subprocess.run(['sudo', '-n', 'mkdir', str(denied)], check=True)
            subprocess.run(['sudo', '-n', 'chown', f'0:{os.getgid()}', str(denied)], check=True)
            subprocess.run(['sudo', '-n', 'chmod', '2775', str(denied)], check=True)
            self.assertFalse(os.access(denied, os.R_OK | os.W_OK | os.X_OK))
            subprocess.run(['sudo', '-n', 'rmdir', str(denied)], check=True)
            self.assertEqual(run_setup(home).returncode, 0)
            self.assertNotIn('system.posix_acl_default', os.listxattr(target))
            self.assertNotIn('system.posix_acl_access', os.listxattr(target))
            self.assertIn('system.posix_acl_default', os.listxattr(target.parent))
            date = target / '2026-11-24'
            session = date / 'session-fixture'
            for directory in (date, session):
                subprocess.run(['sudo', '-n', 'mkdir', str(directory)], check=True)
                subprocess.run(['sudo', '-n', 'chown', f'0:{os.getgid()}', str(directory)], check=True)
                subprocess.run(['sudo', '-n', 'chmod', '2775', str(directory)], check=True)
                self.assertTrue(os.access(directory, os.R_OK | os.W_OK | os.X_OK))
            marker = session / 'existing.txt'
            marker.write_text('preserved')
            try:
                for _ in range(2):
                    result = run_setup(home)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    for directory in (date, session):
                        info = directory.stat()
                        self.assertEqual(info.st_uid, 0)
                        self.assertEqual(info.st_gid, os.getgid())
                        self.assertEqual(stat.S_IMODE(info.st_mode), 0o2775)
                    self.assertEqual(marker.read_text(), 'preserved')
                for bad_mode in ('2755', '2777'):
                    subprocess.run(
                        ['sudo', '-n', 'chmod', bad_mode, str(session)],
                        check=True, capture_output=True,
                    )
                    result = run_setup(home)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('UNSAFE_OWNER_OR_MODE', result.stderr)
            finally:
                subprocess.run(
                    ['sudo', '-n', 'chmod', '2775', str(session)],
                    check=True, capture_output=True,
                )

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
        self.assertLess(INSTALLER.index('fresh_install=0'), INSTALLER.index('run_oc_user python3 - "$SHARED_CHATS_DIR"'))
        self.assertLess(INSTALLER.index('migration_status=\x27not_required\x27'), INSTALLER.index('run_oc_user python3 - "$SHARED_CHATS_DIR"'))
        self.assertIn('OPENCHAMBER_EXECUTION_UID=%s', INSTALLER)
        self.assertIn('OPENCHAMBER_EXECUTION_GID=%s', INSTALLER)
        self.assertIn('OPENCHAMBER_DATA_DIR=/root/.config/openchamber', INSTALLER)
        self.assertIn('NODE_OPTIONS="--require /usr/local/lib/my-opencode/openchamber-child-boundary.cjs"', INSTALLER)
        self.assertIn('OPENCODE_SKIP_START=true', INSTALLER)
        self.assertNotIn('chmod -R 777', INSTALLER)


if __name__ == '__main__':
    unittest.main()
