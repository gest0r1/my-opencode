#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts'/'migrate-openchamber-to-root.py'
class TestMigration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        p=Path(self.temp.name)
        self.src=p/'source'
        self.dst=p/'root'/'data'
        self.state=p/'state'
        self.src.mkdir()
        (self.src/'jwt-secret').write_text('preserve-user-session-secret')
        (self.src/'settings.json').write_text('{"projects":["p1"]}')
        (self.src/'projects').mkdir()
        (self.src/'projects'/'notes.md').write_text('original')
        self.env={**os.environ,'OPENCHAMBER_MIGRATION_TEST':'1'}
    def run_cmd(self,action,*opts):
        proc=subprocess.run([sys.executable,str(SCRIPT),action,'--source',str(self.src),'--destination',str(self.dst),'--state-dir',str(self.state),*opts],env=self.env,text=True,capture_output=True)
        return proc.returncode,json.loads(proc.stdout if proc.returncode==0 else proc.stderr)
    def test_clean_upgrade_and_repeat(self):
        self.assertNotEqual(self.run_cmd('stage')[0],0)
        self.assertEqual(self.run_cmd('stage','--quiescent','yes')[1]['status'],'staged')
        self.assertEqual((self.dst/'jwt-secret').read_text(),'preserve-user-session-secret')
        self.assertEqual((self.src/'jwt-secret').read_text(),'preserve-user-session-secret')
        self.assertEqual(self.dst.stat().st_mode&0o077,0)
        self.assertNotEqual(self.run_cmd('complete')[0],0)
        self.assertEqual(self.run_cmd('complete','--ready','yes')[1]['status'],'completed')
        self.assertEqual(self.run_cmd('stage','--quiescent','yes')[1]['status'],'completed')
    def test_preserve_historical_root_backup(self):
        self.dst.parent.mkdir(parents=True)
        self.dst.mkdir()
        (self.dst/'old').write_text('historical')
        self.assertEqual(self.run_cmd('stage','--quiescent','yes')[1]['status'],'staged')
        self.assertEqual((self.dst/'old').read_text(),'historical')
        before=list(self.dst.parent.glob('.openchamber.p1-previous-*'))
        self.assertEqual(len(before),1)
        self.assertEqual((before[0]/'old').read_text(),'historical')
        self.assertEqual(self.run_cmd('rollback')[1]['status'],'rolled_back')
        self.assertEqual((self.dst/'old').read_text(),'historical')
        self.assertTrue(self.src.exists())
    def test_current_files_win_and_conflicts_are_reported_without_data_loss(self):
        self.dst.parent.mkdir(parents=True)
        self.dst.mkdir()
        (self.dst/'settings.json').write_text('{"projects":["historical"]}')
        (self.dst/'root-only.json').write_text('{"old":"preserved"}')
        (self.dst/'projects').mkdir()
        (self.dst/'projects'/'notes.md').write_text('historic note')
        (self.dst/'projects'/'root-note.md').write_text('root-only note')
        result=self.run_cmd('stage','--quiescent','yes')[1]
        self.assertEqual(result['status'],'staged')
        self.assertEqual(result['historical_conflicts'],2)
        self.assertEqual((self.dst/'settings.json').read_text(),'{"projects":["p1"]}')
        self.assertEqual((self.dst/'projects'/'notes.md').read_text(),'original')
        self.assertEqual((self.dst/'root-only.json').read_text(),'{"old":"preserved"}')
        self.assertEqual((self.dst/'projects'/'root-note.md').read_text(),'root-only note')
        previous=next(self.dst.parent.glob('.openchamber.p1-previous-*'))
        self.assertEqual((previous/'settings.json').read_text(),'{"projects":["historical"]}')
        state=json.loads((self.state/'state.json').read_text())
        self.assertEqual(sorted(state['historical_conflicts']),['projects/notes.md','settings.json'])
        self.assertEqual(self.run_cmd('rollback')[1]['status'],'rolled_back')
        self.assertEqual((self.dst/'settings.json').read_text(),'{"projects":["historical"]}')
        self.assertEqual((self.src/'settings.json').read_text(),'{"projects":["p1"]}')

    def test_reject_historical_symlink(self):
        self.dst.parent.mkdir(parents=True)
        self.dst.mkdir()
        (self.dst/'sneaky').symlink_to('/etc/passwd')
        rc,result=self.run_cmd('stage','--quiescent','yes')
        self.assertNotEqual(rc,0)
        self.assertIn('UNSAFE_HISTORICAL_ENTRY',result['error'])

    def test_no_source_fresh_install(self):
        import shutil
        shutil.rmtree(self.src)
        self.assertEqual(self.run_cmd('stage', '--quiescent', 'yes')[1]['status'],'not_required')

    def test_reject_unsafe_symlink(self):
        (self.src/'evil').symlink_to('/etc/passwd')
        code,result=self.run_cmd('stage','--quiescent','yes')
        self.assertNotEqual(code,0)
        self.assertIn('UNSAFE_SOURCE_ENTRY',result['error'])
if __name__=='__main__':unittest.main()