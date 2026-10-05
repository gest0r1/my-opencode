import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state = load('migrate-runtime-state')
processes = load('runtime-processes')
finalizer = load('finalize-runtime-migration')


class StateTests(unittest.TestCase):
    def fixture(self, conflict=False, referenced=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        old, new = root / 'old', root / 'new'
        (new / 'projects/app').mkdir(parents=True)
        path = new / '.local/share/opencode/opencode.db'
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as db:
            db.executescript('''
                CREATE TABLE worktree(project_id TEXT, directory TEXT, time_created INTEGER, metadata TEXT,
                                      PRIMARY KEY(project_id,directory));
                CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT, sandboxes TEXT);
                CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT);
                CREATE TABLE message(id TEXT PRIMARY KEY, body TEXT);
            ''')
            db.execute('INSERT INTO worktree VALUES(?,?,?,?)', ('p', str(old/'projects/app'), 1, 'old' if conflict else None))
            db.execute('INSERT INTO worktree VALUES(?,?,?,?)', ('p', str(new/'projects/app'), 2, 'new'))
            db.execute('INSERT INTO project VALUES(?,?,?)', ('p', str(old/'projects/app'), json.dumps([str(old/'projects/app')])))
            db.execute('INSERT INTO session VALUES(?,?)', ('known-session', str(old/'projects/app')))
            db.execute('INSERT INTO session VALUES(?,?)', ('missing-session', str(old/'missing')))
            db.execute('INSERT INTO message VALUES(?,?)', ('history', 'Original instruction ' + str(old/'projects/app')))
            if referenced:
                db.execute('CREATE TABLE child(id TEXT PRIMARY KEY, project TEXT, directory TEXT, FOREIGN KEY(project,directory) REFERENCES worktree(project_id,directory))')
                db.execute('INSERT INTO child VALUES(?,?,?)', ('child', 'p', str(old/'projects/app')))
        return root, old, new, path

    def test_collision_history_json_missing_and_idempotence(self):
        root, old, new, path = self.fixture()
        mapping = state.Mapping(str(old), str(new))
        result = state.migrate(new, mapping, root/'backup')
        self.assertEqual(result[str(path)]['merged'], 1)
        self.assertIn(str(old/'missing'), result['missing_targets'])
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM session').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT time_created,metadata FROM worktree').fetchone(), (1, 'new'))
            self.assertEqual(json.loads(db.execute('SELECT sandboxes FROM project').fetchone()[0]), [str(new/'projects/app')])
            self.assertEqual(db.execute('SELECT body FROM message').fetchone()[0], 'Original instruction ' + str(old/'projects/app'))
            self.assertEqual(db.execute('SELECT directory FROM session WHERE id=?', ('known-session',)).fetchone()[0], str(new/'projects/app'))
        again = state.migrate(new, mapping, root/'backup-again')
        self.assertEqual(again[str(path)]['updated'], 0)
        self.assertEqual(again[str(path)]['merged'], 0)

    def test_conflicting_metadata_and_incoming_fk_roll_back(self):
        for options in ({'conflict': True}, {'referenced': True}):
            root, old, new, path = self.fixture(**options)
            with sqlite3.connect(path) as db:
                before = list(db.iterdump())
            with self.assertRaises(ValueError):
                state.migrate(new, state.Mapping(str(old), str(new)), root/'backup')
            with sqlite3.connect(path) as db:
                self.assertEqual(list(db.iterdump()), before)

    def test_registry_collision_merge_and_rollback_on_late_json_failure(self):
        import base64
        root, old, new, path = self.fixture()
        config = new/'.config/openchamber'
        config.mkdir(parents=True)
        def registry(directory):
            return config/('path_' + base64.urlsafe_b64encode(str(directory).encode()).decode().rstrip('=') + '.json')
        source = registry(old/'projects/app')
        canonical = registry(new/'projects/app')
        source.write_text(json.dumps({'sessions': ['old'], 'directory': str(old/'projects/app')}))
        canonical.write_text(json.dumps({'sessions': ['new'], 'directory': str(new/'projects/app')}))
        state.migrate(new, state.Mapping(str(old), str(new)), root/'backup')
        self.assertFalse(source.exists())
        self.assertEqual(json.loads(canonical.read_text())['sessions'], ['new', 'old'])
        self.assertTrue((root/'backup').exists())
        # A bad JSON state file must roll back an already successful DB migration.
        root2, old2, new2, path2 = self.fixture()
        config2 = new2/'.config/openchamber'
        config2.mkdir(parents=True)
        (config2/'broken.json').write_text('{bad')
        with self.assertRaises(json.JSONDecodeError):
            state.migrate(new2, state.Mapping(str(old2), str(new2)), root2/'backup')
        with sqlite3.connect(path2) as db:
            self.assertEqual(db.execute('SELECT directory FROM session WHERE id=?', ('known-session',)).fetchone()[0], str(old2/'projects/app'))

    def test_backup_includes_wal_commits(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = sqlite3.connect(Path(tmp)/'live.db')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE session(id TEXT PRIMARY KEY)')
            db.execute("INSERT INTO session VALUES('committed-in-wal')")
            db.commit()
            state.backup_sqlite(Path(tmp)/'live.db', Path(tmp)/'backup.db')
            with sqlite3.connect(Path(tmp)/'backup.db') as copy:
                self.assertEqual(copy.execute('SELECT id FROM session').fetchone()[0], 'committed-in-wal')
            db.close()

    def test_final_sync_refreshes_prepared_state_and_restores_on_failure(self):
        for fail in (False, True):
            root, old, new, database = self.fixture()
            snapshot = root/'snapshot'
            snapshot.mkdir()
            relative = '.local/share/opencode/opencode.db'
            source = snapshot/relative
            source.parent.mkdir(parents=True)
            state.backup_sqlite(database, source)
            with sqlite3.connect(source) as db:
                db.execute('INSERT INTO session VALUES(?,?)', ('late-session', str(old/'projects/app')))
            marker = new/'.local/state/my-opencode/root-state-sync.pending'
            marker.parent.mkdir(parents=True)
            marker.write_text('pending')
            data = {'home': str(new), 'source_home': str(old),
                    'source_projects': str(old/'projects'), 'target_projects': str(new/'projects'),
                    'copied_files': {relative: finalizer.digest(database)}}
            if fail:
                bad = snapshot/'.config/openchamber/broken.json'
                bad.parent.mkdir(parents=True)
                bad.write_text('{bad')
            modules = lambda name: state if name == 'migrate-runtime-state' else SimpleNamespace(collect=lambda: [])
            with patch.object(finalizer.os, 'geteuid', return_value=1001), patch.object(finalizer, 'module', side_effect=modules):
                if fail:
                    with self.assertRaises(json.JSONDecodeError): finalizer.apply(snapshot, data)
                else:
                    finalizer.apply(snapshot, data)
            with sqlite3.connect(database) as db:
                ids = [row[0] for row in db.execute('SELECT id FROM session')]
            self.assertEqual('late-session' in ids, not fail)
            self.assertEqual(marker.exists(), fail)
            if fail: self.assertFalse((new/'.config/openchamber/broken.json').exists())

    def test_inventory_excludes_infrastructure_and_diagnostic_shell(self):
        rows = processes.inventory('''1 0 0 /sbin/init
2 1 1001 /usr/lib/systemd/systemd --user
3 2 1001 (sd-pam)
4 2 1001 dbus-daemon --session
5 2 1001 /home/opencode/.opencode/bin/opencode serve --stdio --port 0
6 2 1001 node /home/opencode/.local/share/openchamber/server/index.js
7 2 0 bash -c 'cat /home/opencode/.opencode/bin/opencode serve'
''')
        self.assertEqual([r['pid'] for r in rows if r['runtime']], [5, 6])
        self.assertTrue(processes.embedded(rows, 5))
        self.assertFalse(processes.embedded(rows, 7))
        for invalid in ('', 'malformed', '1 2 uid command'):
            with self.assertRaises(ValueError): processes.inventory(invalid)
        with self.assertRaises(ValueError): processes.embedded(rows, 99)

    def test_ps_failure_is_not_empty_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            ps = Path(tmp)/'ps'
            ps.write_text('#!/bin/sh\nexit 42\n')
            ps.chmod(0o755)
            result = subprocess.run(['python3', str(ROOT/'scripts/runtime-processes.py'), '--uid', '0', '--require-stopped'],
                                    env={**os.environ, 'PATH': tmp + ':' + os.environ['PATH']}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__': unittest.main()
