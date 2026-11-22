#!/usr/bin/env python3
"""CI-only root-owned broker test with real Unix peer credentials, sockets and ledger."""
import json, os, pwd, shutil, socket, subprocess, sys, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BROKER = ROOT / 'scripts/opencode-owner-approvald.py'
LEDGER = ROOT / 'scripts/opencode-owner-approval.py'
RUN_ROOT = Path('/run/my-opencode-approval')
DATA_ROOT = Path('/var/lib/my-opencode-approval')

class RealUidBroker(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.getuid() == 0:
            raise unittest.SkipTest('must run from unprivileged CI account')
        if shutil.which('sudo') is None or subprocess.run(['sudo','-n','true'],capture_output=True).returncode:
            raise unittest.SkipTest('root sudo required for real UID integration')
        cls.created = False
        try: pwd.getpwnam('opencode')
        except KeyError:
            subprocess.run(['sudo','-n','useradd','-m','-s','/usr/sbin/nologin','opencode'],check=True)
            cls.created = True
        cls.uid = pwd.getpwnam('opencode').pw_uid
        # On ephemeral CI runner only. Refuse nonempty production ledger.
        for root in (RUN_ROOT,DATA_ROOT):
            if root.exists(): raise AssertionError('CI expects empty broker roots: '+str(root))
        subprocess.run(['sudo','-n','install','-d','-o','root','-g','root','-m','700','/usr/local/lib/my-opencode'],check=True)
        for source in (BROKER,LEDGER):
            subprocess.run(['sudo','-n','install','-o','root','-g','root','-m','644',str(source),'/usr/local/lib/my-opencode/'+source.name],check=True)
        cls.proc=subprocess.Popen(['sudo','-n','python3','/usr/local/lib/my-opencode/opencode-owner-approvald.py'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for _ in range(60):
            if (RUN_ROOT/'agent.sock').exists() and (RUN_ROOT/'owner.sock').exists(): break
            if cls.proc.poll() is not None: raise AssertionError(cls.proc.communicate()[1])
            time.sleep(.1)
        else: raise AssertionError('broker did not create sockets')

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls,'proc'):
            cls.proc.terminate()
            try: cls.proc.wait(timeout=8)
            except subprocess.TimeoutExpired: cls.proc.kill();cls.proc.wait()
        subprocess.run(['sudo','-n','rm','-rf',str(RUN_ROOT),str(DATA_ROOT),'/usr/local/lib/my-opencode/opencode-owner-approvald.py','/usr/local/lib/my-opencode/opencode-owner-approval.py'],check=False)
        if getattr(cls,'created',False): subprocess.run(['sudo','-n','userdel','-r','opencode'],capture_output=True)

    def sock(self,path,data,as_user=None):
        code='''import json,socket,sys
s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.sendall((sys.argv[2]+"\\n").encode());print(s.makefile().readline())'''
        args=['python3','-c',code,str(path),json.dumps(data)]
        if as_user:args=['sudo','-n','-u',as_user,*args]
        p=subprocess.run(args,capture_output=True,text=True)
        return p

    def test_peer_boundary_and_owner_grant(self):
        cp={name:'a'*64 for name in ('manifest_sha256','subject_sha256')}
        cp.update({'run_instance_id':'run-instance-1','run_id':'run-1','operation':'plan.final_manifest.approve','pipeline_id':'plan','stage':'approval','generation':1,'candidate_sha':''})
        request={'action':'submit','checkpoint':cp}
        unauthorized=self.sock(RUN_ROOT/'owner.sock',{'action':'list'})
        self.assertNotEqual(unauthorized.returncode,0,unauthorized.stdout)
        self.assertNotIn('pending',unauthorized.stdout)
        # Never grant without human root action.
        p=self.sock(RUN_ROOT/'agent.sock',request,as_user='opencode')
        self.assertEqual(p.returncode,0,p.stderr)
        data=json.loads(p.stdout)['ok'];self.assertEqual(data['decision'],'pending')
        rid=data['id']
        wrong=self.sock(RUN_ROOT/'owner.sock',{'action':'approve','request_id':rid},as_user='opencode')
        self.assertNotEqual(wrong.returncode,0)
        status=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':cp},as_user='opencode')
        self.assertFalse(json.loads(status.stdout)['ok']['authorized'])
        owner=self.sock(RUN_ROOT/'owner.sock',{'action':'approve','request_id':rid})
        self.assertEqual(json.loads(owner.stdout)['ok']['decision'],'approved')
        consumed=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':cp},as_user='opencode')
        self.assertTrue(json.loads(consumed.stdout)['ok']['authorized'])
        tampered={**cp,'manifest_sha256':'b'*64}
        mismatch=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':tampered},as_user='opencode')
        self.assertEqual(json.loads(mismatch.stdout)['error'],'CHECKPOINT_MISMATCH')
        self.assertEqual((DATA_ROOT/'ledger.sqlite3').stat().st_mode&0o077,0)
        self.assertEqual((RUN_ROOT/'owner.sock').stat().st_mode&0o077,0)
if __name__=='__main__':unittest.main()