#!/usr/bin/env python3
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/migrate-openchamber-profile.py'
SPEC = importlib.util.spec_from_file_location('unified_profile', SCRIPT)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


def archive(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as root:
        for path, text in files.items():
            record = tarfile.TarInfo(path)
            content = text.encode()
            record.size = len(content)
            root.addfile(record, io.BytesIO(content))
    stream.seek(0)
    return stream


class UnifiedMigrationTests(unittest.TestCase):
    def test_preserves_unique_chats_and_profiles_switches_atomically_and_can_roll_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            active = parent / 'openchamber'
            (active / 'chats' / 'existing').mkdir(parents=True)
            (active / 'chats' / 'existing' / 'message').write_text('chat')
            (active / 'settings.json').write_text('{"theme":"historical"}')
            root = str(PROFILE.LEGACY)
            source = archive({'settings.json': json.dumps({'theme': 'active', 'project': root + '/projects/foo'}),
                              'extensions/profile/settings': 'cookies', 'startup.env': 'OPENCODE_SKIP_START=1\nOPENCHAMBER_BIND_PORT=3000\n'})
            transaction = 'a' * 32
            prepared = PROFILE.stage_profile(parent, transaction, source)
            self.assertEqual(prepared['conflicts'], ['settings.json'])
            self.assertEqual(json.loads((active / 'settings.json').read_text())['theme'], 'historical')
            PROFILE.switch_profile(parent, transaction)
            PROFILE.switch_profile(parent, transaction)
            settings = json.loads((active / 'settings.json').read_text())
            self.assertEqual(settings, {'theme': 'active', 'project': str(active / 'projects/foo')})
            self.assertEqual((active / 'chats/existing/message').read_text(), 'chat')
            self.assertEqual((active / 'extensions/profile/settings').read_text(), 'cookies')
            self.assertEqual((active / 'startup.env').read_text(), 'OPENCHAMBER_BIND_PORT=3000\n')
            PROFILE.switch_profile(parent, transaction, rollback=True)
            PROFILE.switch_profile(parent, transaction, rollback=True)
            self.assertEqual(json.loads((active / 'settings.json').read_text())['theme'], 'historical')

    def test_archive_rejects_escape_and_does_not_replace_active_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            (parent / 'openchamber').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ARCHIVE_ENTRY_REFUSED'):
                PROFILE.stage_profile(parent, 'a' * 32, archive({'../escape': 'invalid'}))
            self.assertTrue((parent / 'openchamber').is_dir())
            self.assertFalse((parent / 'escape').exists())


if __name__ == '__main__':
    unittest.main()
