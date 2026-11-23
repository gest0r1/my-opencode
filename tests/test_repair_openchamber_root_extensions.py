#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'repair-openchamber-root-extensions.py'
spec = importlib.util.spec_from_file_location('extension_path_repair', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtensionPathRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.old = base / 'legacy' / 'extensions'
        self.new = base / 'root'
        self.new.mkdir()
        (self.new / 'extensions' / 'server-browser').mkdir(parents=True)
        (self.new / 'extensions' / 'excalidraw').mkdir()
        self.browser = str(self.old / 'server-browser')
        self.excalidraw = str(self.old / 'excalidraw')
        self.original = {
            'paths': [self.browser, self.excalidraw],
            'sources': {self.browser: 'git', self.excalidraw: 'git'},
            'gitOrigins': {
                self.browser: {'url': 'https://github.com/gest0r1/openchamber-server-browser----.git',
                               'ref': 'feature/persistent-project-profiles'},
                self.excalidraw: {'url': 'https://github.com/openchamber/openchamber-excalidraw'},
            },
            'capabilityGrants': {'server-browser': ['service']},
            'storageIds': {'server-browser': 'dee48323-fb9e-482b-850d-1febef3d93f1'},
        }
        (self.new / 'extensions.json').write_text(json.dumps(self.original))

    def repair(self):
        return module.repair(self.new, test_mode=True, old_dir=self.old)

    def test_rebases_only_owned_extension_paths_and_preserves_grants_and_git_origins(self):
        result = self.repair()
        self.assertEqual(result['status'], 'repaired')
        data = json.loads((self.new / 'extensions.json').read_text())
        paths = [str(self.new / 'extensions' / 'server-browser'), str(self.new / 'extensions' / 'excalidraw')]
        self.assertEqual(data['paths'], paths)
        self.assertEqual(data['gitOrigins'][paths[0]], self.original['gitOrigins'][self.browser])
        self.assertEqual(data['storageIds'], self.original['storageIds'])
        self.assertEqual(data['capabilityGrants'], self.original['capabilityGrants'])
        self.assertEqual(json.loads((self.new / 'extensions.json.pre-root-path-rebase').read_text()), self.original)
        self.assertEqual(self.repair()['status'], 'already_valid')

    def test_refuses_missing_migrated_copy_without_rewriting_catalog(self):
        (self.new / 'extensions' / 'server-browser').rmdir()
        with self.assertRaisesRegex(module.Refused, 'EXTENSION_COPY_MISSING'):
            self.repair()
        self.assertEqual(json.loads((self.new / 'extensions.json').read_text()), self.original)

    def test_refuses_symlink_to_outside_source(self):
        (self.new / 'extensions' / 'server-browser').rmdir()
        (self.new / 'extensions' / 'server-browser').symlink_to('/etc')
        with self.assertRaisesRegex(module.Refused, 'EXTENSION_COPY_MISSING_OR_SYMLINK'):
            self.repair()

    def test_preserves_external_paths(self):
        external = '/opt/custom/public-extension'
        self.original['paths'].append(external)
        self.original['sources'][external] = 'path'
        (self.new / 'extensions.json').write_text(json.dumps(self.original))
        self.repair()
        data = json.loads((self.new / 'extensions.json').read_text())
        self.assertIn(external, data['paths'])
        self.assertEqual(data['sources'][external], 'path')


if __name__ == '__main__':
    unittest.main()
