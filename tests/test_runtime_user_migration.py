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
        # Node must be reachable through the managed user PATH, not inherited
        # from the administrative test runner's private installation.
        import shutil
        (dst / '.local/bin').mkdir(parents=True)
        (dst / '.local/bin/node').symlink_to(shutil.which('node'))
        commands = {
            'id': 'case "$1" in -u) echo 1234;; -gn) echo testgroup;; *) [[ "${TEST_CREATE_USER:-0}" != 1 || -f "$TEST_USER_CREATED" ]];; esac',
            'getent': 'echo "opencode:x:1234:1234::' + str(dst) + ':/bin/bash"',
            'chown': 'exit 0',
            'useradd': '[[ -z "${TEST_USER_CREATED:-}" ]] || touch "$TEST_USER_CREATED"',
            'sudo': 'exit 0',
            'visudo': 'exit 0',
            'loginctl': 'exit 0',
            'runuser': 'shift 3; exec "$@"',
            'systemctl': 'echo "$*" >> "$TEST_TRACE"; case "$*" in *is-active*) exit 0;; *"-p User"*) echo root;; esac',
            'node': '[[ "${TEST_FAIL_NODE:-0}" != 1 ]]',
            'gh': 'exit 0',
            'ps': 'printf \"1 0 0 init\\n\"; if [[ \"${TEST_ACTIVE_RUNTIME:-0}\" == 1 ]]; then printf \"5 1 1234 opencode serve\\n\"; fi',
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
        env['OPENCHAMBER_EMBEDDED_TERMINAL'] = '1'
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
        service_trace = trace.read_text()
        self.assertIn('start user@1234.service', service_trace)
        self.assertNotIn('openchamber.service', service_trace)
        self.assertNotIn('opencode-web.service', service_trace)
        self.assertNotIn('opencode-web-reboot.path', service_trace)
        self.assertIn('were NOT stopped or disabled', result.stdout)
        self.assertEqual(self.run_script(env).returncode, 0)
        helper = Path(env['OPENCODE_SUDO_PREFIX']) / 'usr/local/sbin/opencode-install-packages'
        cutover = Path(env['OPENCODE_SUDO_PREFIX']) / 'usr/local/sbin/opencode-runtime-cutover'
        self.assertEqual(subprocess.run(['bash', str(helper), '--check']).returncode, 0)
        self.assertEqual(subprocess.run(['bash', str(helper), 'install', '--option']).returncode, 2)
        self.assertEqual(subprocess.run(['bash', str(cutover), '--check']).returncode, 0)
        policy = Path(env['OPENCODE_SUDO_PREFIX']) / 'etc/sudoers.d/opencode-packages-opencode'
        self.assertIn('opencode ALL=(root) NOPASSWD:', policy.read_text())
        self.assertIn('opencode-runtime-cutover', policy.read_text())
        self.assertEqual(policy.stat().st_mode & 0o777, 0o440)

    def test_failure_does_not_touch_existing_runtime_services(self):
        src, dst, bins, trace, env = self.fixture()
        (src / '.local/bin').mkdir(parents=True)
        (src / '.local/bin/cli').write_text('fixture\n')
        (dst / '.local').mkdir(exist_ok=True)
        import shutil
        shutil.rmtree(dst / '.local/bin')
        (dst / '.local/bin').symlink_to(bins)
        result = self.run_script(env)
        self.assertNotEqual(result.returncode, 0)
        service_trace = trace.read_text()
        self.assertIn('start user@1234.service', service_trace)
        self.assertNotIn('openchamber.service', service_trace)
        self.assertNotIn('opencode-web.service', service_trace)
        self.assertFalse((dst / '.local/state/my-opencode/root-user-migration.done').exists())

    def test_missing_user_is_created(self):
        src, dst, bins, trace, env = self.fixture()
        env['TEST_CREATE_USER'] = '1'
        result = self.run_script(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(Path(env['TEST_USER_CREATED']).exists())
        self.assertIn('Creating runtime user: opencode', result.stdout)

    def test_active_target_runtime_blocks_before_copy(self):
        src, dst, bins, trace, env = self.fixture()
        env['TEST_ACTIVE_RUNTIME'] = '1'
        result = self.run_script(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still active', result.stderr)
        self.assertFalse(trace.exists())

    def test_invalid_options_do_not_stop_services(self):
        src, dst, bins, trace, env = self.fixture()
        env['OPENCODE_MIGRATE_PROJECTS'] = 'invalid'
        result = self.run_script(env)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(trace.exists())
        env['OPENCODE_MIGRATE_PROJECTS'] = '1'
        env['OPENCODE_RUNTIME_USER'] = 'wrong-user'
        result = self.run_script(env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('required name is exactly opencode', result.stderr)
        self.assertFalse(trace.exists())


if __name__ == '__main__': unittest.main()
