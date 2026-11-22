#!/usr/bin/env python3
"""Verify root service launches with inert, private OpenCode password bytes."""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
LAUNCHER=ROOT/'scripts/launch-openchamber-root.sh'
POLICY=Path('/etc/my-opencode')
SECRET=POLICY/'opencode-connect.secret'

class RootLauncher(unittest.TestCase):
    def setUp(self):
        if os.getuid()==0 or not shutil.which('sudo') or subprocess.run(['sudo','-n','true'],capture_output=True).returncode:
            self.skipTest('requires ephemeral GitHub runner with sudo from unprivileged account')
        if POLICY.exists(): self.skipTest('refusing existing host policy path')
        subprocess.run(['sudo','-n','install','-d','-o','root','-g','root','-m','711',str(POLICY)],check=True)

    def tearDown(self):
        if POLICY.exists():
            subprocess.run(['sudo','-n','rm','-f',str(SECRET)],check=False)
            subprocess.run(['sudo','-n','rmdir',str(POLICY)],check=False)

    def launch(self):
        return subprocess.run(['sudo','-n','bash',str(LAUNCHER),'/usr/bin/python3','-c',
                               'import json,os;print(json.dumps(os.getenv("OPENCODE_PASSWORD")))'],
                              capture_output=True,text=True)

    def test_passwordless_and_complex_password_and_misconfigured_permissions(self):
        blank=self.launch()
        self.assertEqual(blank.returncode,0,blank.stderr)
        self.assertEqual(json.loads(blank.stdout),None)

        secret='a# b"q\'d+$:!-%%\\'
        writer=subprocess.run(['sudo','-n','tee',str(SECRET)],input=secret,text=True,capture_output=True)
        self.assertEqual(writer.returncode,0,writer.stderr)
        subprocess.run(['sudo','-n','chmod','600',str(SECRET)],check=True)
        accepted=self.launch()
        self.assertEqual(accepted.returncode,0,accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout),secret)

        subprocess.run(['sudo','-n','chmod','644',str(SECRET)],check=True)
        weak=self.launch()
        self.assertNotEqual(weak.returncode,0)
        self.assertIn('OPENCODE_CONNECT_SECRET_UNTRUSTED',weak.stderr)

        subprocess.run(['sudo','-n','rm','-f',str(SECRET)],check=True)
        subprocess.run(['sudo','-n','ln','-s','/etc/passwd',str(SECRET)],check=True)
        linked=self.launch()
        self.assertNotEqual(linked.returncode,0)
        self.assertIn('OPENCODE_CONNECT_SECRET_UNTRUSTED',linked.stderr)

if __name__=='__main__': unittest.main()
