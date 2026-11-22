#!/usr/bin/env python3
"""Root-only integration: every generic Node child_process action drops to runner UID."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'openchamber-child-boundary.cjs'

class RootChildBoundary(unittest.TestCase):
    def test_real_uid_drop(self):
        if os.geteuid() == 0:
            self.skipTest('CI runner should be nonroot for this check')
        if not shutil.which('sudo'):
            self.skipTest('sudo not installed')
        uid, gid = os.geteuid(), os.getegid()
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
    def test_deny_without_isolation(self):
        p=subprocess.run(['sudo','-n','env','OPENCHAMBER_ROOT_MODE=','node','--require',str(SCRIPT),'-e','console.log("bad")'],capture_output=True,text=True,timeout=25)
        if p.returncode==127:
            self.skipTest('sudo unavailable')
        self.assertNotEqual(p.returncode,0)
        self.assertIn('ROOT_CHILD_EXECUTION_FORBIDDEN',p.stderr)
if __name__=='__main__': unittest.main()