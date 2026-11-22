#!/usr/bin/env python3
"""Root-only integration: every generic Node child_process action drops to runner UID."""
import json
import os
import pwd
from pathlib import Path
import shutil
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'openchamber-child-boundary.cjs'

class RootChildBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.created=False
        if os.geteuid() == 0: return
        try:
            cls.exec_user=pwd.getpwnam('opencode')
        except KeyError:
            subprocess.run(['sudo','-n','useradd','-m','-s','/bin/bash','opencode'],check=True)
            cls.created=True
            cls.exec_user=pwd.getpwnam('opencode')

    @classmethod
    def tearDownClass(cls):
        if getattr(cls,'created',False):
            subprocess.run(['sudo','-n','userdel','-r','opencode'],capture_output=True)

    def test_real_uid_drop(self):
        if os.geteuid() == 0:
            self.skipTest('CI runner should be nonroot for this check')
        if not shutil.which('sudo'):
            self.skipTest('sudo not installed')
        uid, gid = self.exec_user.pw_uid, self.exec_user.pw_gid
        source = r'''
const c=require('node:child_process');
let ids=[];
ids.push(c.spawnSync('/usr/bin/id',['-u']).stdout.toString().trim());
ids.push(c.execFileSync('/usr/bin/id',['-u']).toString().trim());
ids.push(c.execSync('/usr/bin/id -u').toString().trim());
c.execFile('/usr/bin/id',['-u'],{},(err,out)=>{if(err)throw err;ids.push(out.trim());console.log(JSON.stringify(ids));});
'''
        env = ['OPENCHAMBER_ROOT_MODE=separated',f'OPENCHAMBER_EXECUTION_UID={uid}',f'OPENCHAMBER_EXECUTION_GID={gid}']
        p = subprocess.run(['sudo','-n','env',*env,'node','--require',str(SCRIPT),'-e',source],capture_output=True,text=True,timeout=25)
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(json.loads(p.stdout),[str(uid)]*4)
    def test_promisified_exec_file_and_exec_keep_node_contract_and_uid(self):
        if os.geteuid() == 0:
            self.skipTest('CI runner should be nonroot for this check')
        if not shutil.which('sudo'):
            self.skipTest('sudo not installed')
        uid, gid = self.exec_user.pw_uid, self.exec_user.pw_gid
        source = r'''
const { promisify } = require('node:util');
const child = require('node:child_process');
(async () => {
  const file = await promisify(child.execFile)('/usr/bin/id', ['-u']);
  const exec = await promisify(child.exec)('id -u');
  const { execFile: esmExecFile } = await import('node:child_process');
  const esm = await promisify(esmExecFile)('/usr/bin/id', ['-u']);
  const environment = await promisify(child.execFile)('/usr/bin/env', []);
  let failure = null;
  try {
    await promisify(child.execFile)('/bin/sh', ['-c', 'printf failed-out; printf failed-err >&2; exit 7']);
  } catch (error) {
    failure = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  console.log(JSON.stringify({
    file: file.stdout.trim(), fileStderr: file.stderr,
    exec: exec.stdout.trim(), execStderr: exec.stderr,
    esm: esm.stdout.trim(),
    secretsFiltered: !environment.stdout.split('\\n').some(line => /^(GH_TOKEN|OPENCODE_PASSWORD)=/.test(line)),
    failure,
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        args = [
            'sudo', '-n', 'env',
            'OPENCHAMBER_ROOT_MODE=separated',
            f'OPENCHAMBER_EXECUTION_UID={uid}',
            f'OPENCHAMBER_EXECUTION_GID={gid}',
            'GH_TOKEN=DO_NOT_INHERIT_P1',
            'OPENCODE_PASSWORD=DO_NOT_INHERIT_P1',
            'node', '--require', str(SCRIPT), '-e', source,
        ]
        result = subprocess.run(args, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'file': str(uid), 'fileStderr': '',
            'exec': str(uid), 'execStderr': '',
            'esm': str(uid), 'secretsFiltered': True,
            'failure': {'code': 7, 'stdout': 'failed-out', 'stderr': 'failed-err'},
        })

    def test_deny_wrong_executor(self):
        if os.geteuid() == 0 or not shutil.which('sudo'): self.skipTest('sudo runner required')
        p=subprocess.run(['sudo','-n','env','OPENCHAMBER_ROOT_MODE=separated',
                          f'OPENCHAMBER_EXECUTION_UID={os.geteuid()}',
                          f'OPENCHAMBER_EXECUTION_GID={os.getegid()}',
                          'node','--require',str(SCRIPT),'-e','console.log("bad")'],
                          capture_output=True,text=True,timeout=25)
        self.assertNotEqual(p.returncode,0)
        self.assertIn('executor must be local opencode',p.stderr)

    def test_deny_without_isolation(self):
        p=subprocess.run(['sudo','-n','env','OPENCHAMBER_ROOT_MODE=','node','--require',str(SCRIPT),'-e','console.log("bad")'],capture_output=True,text=True,timeout=25)
        if p.returncode==127:
            self.skipTest('sudo unavailable')
        self.assertNotEqual(p.returncode,0)
        self.assertIn('ROOT_CHILD_EXECUTION_FORBIDDEN',p.stderr)
if __name__=='__main__': unittest.main()