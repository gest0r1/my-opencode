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
        self.assertFalse((self.dst/'old').exists())
        before=list(self.dst.parent.glob('.openchamber.p1-previous-*'))
        self.assertEqual(len(before),1)
        self.assertEqual((before[0]/'old').read_text(),'historical')
        self.assertEqual(self.run_cmd('rollback')[1]['status'],'rolled_back')
        self.assertEqual((self.dst/'old').read_text(),'historical')
        self.assertTrue(self.src.exists())
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