#!/usr/bin/env python3
"""Installed-systemd acceptance: UI root can read private opencode paths; children cannot escalate.

This test MUST run only on GitHub-hosted disposable runners, after installing
the real systemd units. It does not access production credentials.
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path('/home/opencode/projects/.p1-private-project-fixture')
PROJECT_FILE = FIXTURE_DIR / 'project.txt'
OWNER_FILE = Path('/root/.p1-owner-only-fixture')


def run(*args, **kwargs):
    return subprocess.run(list(args), check=True, text=True, capture_output=True, **kwargs)


def cap_fields(pid):
    content = Path(f'/proc/{pid}/status').read_text()
    fields = {}
    for line in content.splitlines():
        if line.startswith(('CapEff:', 'CapBnd:', 'CapAmb:')):
            key, value = line.split(':', 1)
            fields[key] = int(value.strip(), 16)
    if len(fields) != 3:
        raise AssertionError('Missing capability status fields')
    return fields


class RootDacBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.getenv('RUNNER_ENVIRONMENT') != 'github-hosted' or os.geteuid() == 0:
            raise RuntimeError('This test requires a disposable GitHub-hosted runner user')
        if not shutil.which('systemd-run'):
            raise RuntimeError('systemd-run is required')
        cls.exec_uid = pwd.getpwnam('opencode').pw_uid
        cls.exec_gid = pwd.getpwnam('opencode').pw_gid
        run('sudo', '-n', '-H', '-u', 'opencode', 'install', '-d', '-m', '0700', str(FIXTURE_DIR))
        run('sudo', '-n', 'install', '-o', 'opencode', '-g', 'opencode', '-m', '0600', '/dev/null', str(PROJECT_FILE))
        run('sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '0600', '/dev/null', str(OWNER_FILE))
        selfcheck = run('sudo', '-n', '-H', '-u', 'opencode', 'test', '-r', str(PROJECT_FILE))
        assert selfcheck.returncode == 0

    @classmethod
    def tearDownClass(cls):
        run('sudo', '-n', 'rm', '-f', str(PROJECT_FILE), str(OWNER_FILE))
        run('sudo', '-n', '-H', '-u', 'opencode', 'rmdir', str(FIXTURE_DIR))

    def test_real_root_ui_capability_scope(self):
        pid = int(run('sudo', '-n', 'systemctl', 'show', 'openchamber.service',
                      '--property=MainPID', '--value').stdout.strip())
        self.assertGreater(pid, 1)
        caps = cap_fields(pid)
        owner_caps = (1 << 0) | (1 << 1)  # CAP_CHOWN and CAP_DAC_OVERRIDE
        for field in ('CapEff', 'CapBnd'):
            self.assertEqual(caps[field] & owner_caps, owner_caps, f'{field} missing root UI capabilities')
        self.assertEqual(caps['CapAmb'] & owner_caps, 0, 'owner capabilities must not be ambient')

    def test_node_children_run_unprivileged_without_dac(self):
        node = shutil.which('node')
        if not node:
            raise AssertionError('Missing Node runtime')
        boundary = '/usr/local/lib/my-opencode/openchamber-child-boundary.cjs'
        source = r"""
const fs = require('node:fs');
const child = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-capability-'));
try {
  fs.chownSync(scratch, Number(process.env.OPENCHAMBER_EXECUTION_UID), Number(process.env.OPENCHAMBER_EXECUTION_GID));
  if (fs.statSync(scratch).uid !== Number(process.env.OPENCHAMBER_EXECUTION_UID)) throw Error('scratch ownership mismatch');
} finally { fs.rmdirSync(scratch); }
const privateProject = '__PROJECT__';
const ownerFile = '__OWNER__';
if (!fs.readFileSync(privateProject, 'utf8').includes('')) throw Error('read failed');
const probe = String.raw__
import os
from pathlib import Path
print(os.geteuid())
print(next(l.split()[1] for l in Path('/proc/self/status').read_text().splitlines() if l.startswith('CapEff:')))
try:
    Path('__OWNER__').read_bytes()
    print('LEAK')
except PermissionError:
    print('DENIED')
__;
const result = child.spawnSync('/usr/bin/python3', ['-c', probe], { encoding: 'utf8' });
if (result.error || result.status !== 0) throw Error('child failed: ' + result.stderr);
const lines = result.stdout.trim().split(/\r?\n/);
if (lines[0] !== '__UID__') throw Error('unexpected child uid: ' + lines[0]);
if ((BigInt('0x' + lines[1]) & 0x3n) !== 0n) throw Error('child inherited CHOWN or DAC override');
if (lines[2] !== 'DENIED') throw Error('child could access root private file');
console.log('P1_ROOT_DAC_BOUNDARY_PASS');
"""
        # Replace sentinel delimiters with an ordinary JavaScript template literal.
        source = source.replace('String.raw__', 'String.raw' + chr(96), 1)
        source = source.replace('\n__;', '\n' + chr(96) + ';', 1)
        source = (source.replace('__PROJECT__', str(PROJECT_FILE))
                        .replace('__OWNER__', str(OWNER_FILE))
                        .replace('__UID__', str(self.exec_uid)))
        props = [
            'User=root', 'Group=root',
            'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_CHOWN',
            'AmbientCapabilities=CAP_SETUID CAP_SETGID',
            'NoNewPrivileges=yes', 'ProtectSystem=full', 'PrivateTmp=yes',
        ]
        command = ['sudo', '-n', 'systemd-run', '--wait', '--pipe', '--collect',
                   '--quiet', '--unit=p1-root-dac-smoke',
                   *[f'--property={value}' for value in props],
                   '--setenv=OPENCHAMBER_ROOT_MODE=separated',
                   f'--setenv=OPENCHAMBER_EXECUTION_UID={self.exec_uid}',
                   f'--setenv=OPENCHAMBER_EXECUTION_GID={self.exec_gid}',
                   node, '--require', boundary, '-e', source]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('P1_ROOT_DAC_BOUNDARY_PASS', result.stdout)


if __name__ == '__main__':
    unittest.main()
