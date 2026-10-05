import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/migrate-root-runtime-to-opencode.sh'


@unittest.skipUnless(os.geteuid() == 0, 'migration bootstrap requires root')
class MigrationTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        src, dst, bins = (root / n for n in ('source', 'target', 'bin'))
        for p in (src, dst, bins): p.mkdir()
        trace = root / 'trace'
        commands = {
            'id': 'case "$1" in -u) echo 1234;; -gn) echo testgroup;; *) [[ "${TEST_CREATE_USER:-0}" != 1 || -f "$TEST_USER_CREATED" ]];; esac',
            'getent': 'echo "opencode:x:1234:1234::' + str(dst) + ':/bin/bash"',
            'chown': 'exit 0',
            'useradd': '[[ -z "${TEST_USER_CREATED:-}" ]] || touch "$TEST_USER_CREATED"',
            'usermod': 'exit 0',
            'sudo': 'exit 0',
            'visudo': 'exit 0',
            'loginctl': 'exit 0',
            'runuser': 'shift 3; exec "$@"',
            'systemctl': 'echo "$*" >> "$TEST_TRACE"; case "$*" in *is-active*) exit 0;; *"-p User"*) echo root;; esac',
            'node': '[[ "${TEST_FAIL_NODE:-0}" != 1 ]]',
            'gh': 'exit 0',
        }
        for name, body in commands.items():
            f = bins / name
            f.write_text('#!/bin/bash\n' + body + '\n')
            f.chmod(0o755)
        (bins / 'runuser').write_text('''#!/bin/bash
shift 3
args=()
for arg in "$@"; do
  if [[ "$arg" == PATH=* ]]; then args+=("PATH=$TEST_BIN:/usr/bin:/bin"); else args+=("$arg"); fi
done
exec "${args[@]}"
''')
        # systemctl trace remains available in env -i through the script's literal.
        f = bins / 'systemctl'
        f.write_text('#!/bin/bash\necho "$*" >> "' + str(trace) + '"\ncase "$*" in *is-active*) exit 0;; *"-p User"*) echo root;; esac\n')
        env = dict(os.environ, PATH=f'{bins}:/usr/bin:/bin', TEST_BIN=str(bins), TEST_USER_CREATED=str(root / 'user-created'),
                   OPENCODE_SUDO_PREFIX=str(root / 'sudo-root'), OPENCODE_RUNTIME_USER='opencode', OPENCODE_MIGRATION_SOURCE_HOME=str(src))
        return src, dst, bins, trace, env

    def run_script(self, env):
        return subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True)

    def test_copy_relocates_links_and_runtime_paths_preserving_target(self):
        src, dst, bins, trace, env = self.fixture()
        for home in (src, dst): (home / '.config').mkdir()
        (src / '.config/opencode.env').write_text(f'DATA_DIR={src}/projects\n')
        (src / '.config/gh').mkdir()
        (src / '.config/gh/hosts.yml').write_text('fixture-credential\n')
        (src / 'projects').mkdir()
        (src / 'projects/existing.txt').write_text('source\n')
        (dst / 'projects').mkdir()
        (dst / 'projects/existing.txt').write_text('target\n')
        (src / '.local/bin').mkdir(parents=True)
        (src / '.local/bin/claude').symlink_to(src / '.local/share/claude/cli')
        (src / '.local/share/claude').mkdir(parents=True)
        (src / '.local/share/claude/cli').write_text('fixture\n')
        result = self.run_script(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((dst / '.config/opencode.env').read_text(), f'DATA_DIR={dst}/projects\n')
        self.assertEqual(os.readlink(dst / '.local/bin/claude'), str(dst / '.local/share/claude/cli'))
        self.assertEqual((dst / 'projects/existing.txt').read_text(), 'target\n')
        self.assertTrue((src / '.config/gh/hosts.yml').exists())
        self.assertEqual((dst / '.config/gh/hosts.yml').stat().st_mode & 0o777, 0o600)
        self.assertIn('disable openchamber.service', trace.read_text())
        self.assertEqual(self.run_script(env).returncode, 0)
        helper = Path(env['OPENCODE_SUDO_PREFIX']) / 'usr/local/sbin/opencode-install-packages'
        self.assertEqual(subprocess.run(['bash',str(helper),'--check']).returncode,0)
        self.assertEqual(subprocess.run(['bash',str(helper),'install','--option']).returncode,2)
        policy = Path(env['OPENCODE_SUDO_PREFIX']) / 'etc/sudoers.d/opencode-packages-opencode'
        self.assertIn('opencode ALL=(root) NOPASSWD:',policy.read_text())
        self.assertEqual(policy.stat().st_mode & 0o777,0o440)

    def test_failure_restarts_services_without_disable(self):
        src, dst, bins, trace, env = self.fixture()
        (src / '.local/bin').mkdir(parents=True)
        (src / '.local/bin/cli').write_text('fixture\n')
        (dst / '.local').mkdir()
        (dst / '.local/bin').symlink_to(bins)
        result = self.run_script(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('start openchamber.service', trace.read_text())
        self.assertNotIn('disable openchamber.service', trace.read_text())
        self.assertFalse((dst / '.local/state/my-opencode/root-user-migration.done').exists())

    def test_missing_user_is_created(self):
        src, dst, bins, trace, env = self.fixture()
        env['TEST_CREATE_USER']='1'
        result=self.run_script(env)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(Path(env['TEST_USER_CREATED']).exists())
        self.assertIn('Creating runtime user: opencode',result.stdout)

    def test_invalid_options_do_not_stop_services(self):
        src, dst, bins, trace, env = self.fixture()
        env['OPENCODE_MIGRATE_PROJECTS'] = 'invalid'
        result = self.run_script(env)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(trace.exists())
        env['OPENCODE_MIGRATE_PROJECTS']='1'
        env['OPENCODE_RUNTIME_USER']='wrong-user'
        result=self.run_script(env)
        self.assertEqual(result.returncode,2)
        self.assertIn('required name is exactly opencode',result.stderr)
        self.assertFalse(trace.exists())


if __name__ == '__main__': unittest.main()
