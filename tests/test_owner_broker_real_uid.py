#!/usr/bin/env python3
"""CI-only root-owned broker test with real Unix peer credentials, sockets and ledger."""
import hashlib, json, os, pwd, shutil, socket, subprocess, sys, tempfile, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BROKER = ROOT / 'scripts/opencode-owner-approvald.py'
LEDGER = ROOT / 'scripts/opencode-owner-approval.py'
BROKER_CLIENT = ROOT / 'config/opencode/skills/task-management/scripts/owner-broker-client.mjs'
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
        subprocess.run(['sudo','-n','install','-d','-o','root','-g','root','-m','755','/usr/local/lib/my-opencode'],check=True)
        for source in (BROKER,LEDGER,BROKER_CLIENT):
            subprocess.run(['sudo','-n','install','-o','root','-g','root','-m','644',str(source),'/usr/local/lib/my-opencode/'+source.name],check=True)
        cls.proc=subprocess.Popen(['sudo','-n','python3','/usr/local/lib/my-opencode/opencode-owner-approvald.py'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for _ in range(60):
            if (RUN_ROOT/'agent.sock').exists() and (RUN_ROOT/'owner.sock').exists(): break
            if cls.proc.poll() is not None: raise AssertionError(cls.proc.communicate()[1])
            time.sleep(.1)
        else: raise AssertionError('broker did not create sockets')

    def test_policy_marker_visibility_and_fail_closed_for_agent_uid(self):
        policy=Path('/etc/my-opencode')
        if policy.exists():
            self.skipTest('pre-existing local policy is not modified')
        sudo=['sudo','-n']
        try:
            subprocess.run(sudo+['install','-d','-o','root','-g','root','-m','711',str(policy)],check=True)
            marker=policy/'owner-broker-required'
            subprocess.run(sudo+['install','-o','root','-g','root','-m','644','/dev/null',str(marker)],check=True)
            binary=shutil.which('node')
            self.assertTrue(binary,'node executable required')
            probe="import{ownerBrokerRequired}from 'file:///usr/local/lib/my-opencode/owner-broker-client.mjs';console.log(ownerBrokerRequired())"
            cmd=sudo+['-u','opencode',binary,'--input-type=module','-e',probe]
            ok=subprocess.run(cmd,capture_output=True,text=True)
            self.assertEqual(ok.returncode,0,ok.stderr)
            self.assertEqual(ok.stdout.strip(),'true')
            subprocess.run(sudo+['chmod','700',str(policy)],check=True)
            invisible=subprocess.run(cmd,capture_output=True,text=True)
            self.assertNotEqual(invisible.returncode,0)
            self.assertIn('OWNER_BROKER_POLICY_DIR_UNTRUSTED',invisible.stderr)
            subprocess.run(sudo+['chmod','711',str(policy)],check=True)
            subprocess.run(sudo+['rm','-f',str(marker)],check=True)
            missing=subprocess.run(cmd,capture_output=True,text=True)
            self.assertNotEqual(missing.returncode,0)
            self.assertIn('OWNER_BROKER_POLICY_MARKER_MISSING',missing.stderr)
        finally:
            subprocess.run(sudo+['chmod','711',str(policy)],check=False)
            subprocess.run(sudo+['rm','-rf',str(policy)],check=False)

    def test_plan_and_owner_receipts_reject_forged_state_and_changed_artifacts(self):
        """Real broker, real opencode UID, actual TS checkpoint and receipt logic."""
        policy=Path('/etc/my-opencode')
        if policy.exists(): self.skipTest('pre-existing host policy must not be touched')
        binary=shutil.which('node')
        self.assertTrue(binary,'Node 24 required for native TypeScript stripping')
        temp=Path(tempfile.mkdtemp(prefix='owner-broker-checkpoint-',dir='/tmp'))
        os.chmod(temp,0o755)
        # The hosted runner checkout is not traversable by UID opencode.
        # Copy only the exact tested TS/MJS modules to a temporary read-only
        # public test tree; do not grant the agent access to runner HOME.
        source=temp/'source'
        script_dir=source/'config/opencode/skills/task-management/scripts'
        script_dir.mkdir(parents=True,mode=0o755)
        test_dir=source/'tests'
        test_dir.mkdir(mode=0o755)
        for name in ('owner-approval-checkpoint.ts','owner-broker-client.mjs'):
            shutil.copy2(ROOT/'config/opencode/skills/task-management/scripts'/name,script_dir/name)
        shutil.copy2(ROOT/'tests/owner-broker-receipt-runner.mjs',test_dir/'owner-broker-receipt-runner.mjs')
        runner=test_dir/'owner-broker-receipt-runner.mjs'
        envpath=os.path.dirname(binary)+':'+os.getenv('PATH','')
        def agent(*args):
            return subprocess.run(['sudo','-n','-u','opencode','env','HOME=/home/opencode',
                                   'PATH='+envpath,binary,str(runner),*map(str,args)],
                                  text=True,capture_output=True)
        try:
            raw=json.dumps({'schema_version':2,'run_id':'p1-real-uid-checkpoint'})
            manifest=temp/'manifest.json'; manifest.write_text(raw)
            artifact=temp/'proof.json'; artifact.write_text('{"status":"PASS"}')
            candidate=temp/'candidate.json'
            candidate.write_text(json.dumps({'candidate_sha':'a'*40}))
            state={
                'run_id':'p1-real-uid-checkpoint',
                'created_at':'2026-11-22T10:00:00.000Z',
                'worktree_root':str(temp),
                'manifest_file':str(manifest),
                'manifest_sha256':hashlib.sha256(raw.encode()).hexdigest(),
                'pipelines':{'p1':{
                    'stage_order':['implementation','owner'],
                    'stages':{
                        'implementation':{'status':'completed','evidence':{'artifacts':[str(artifact)]}},
                        'owner':{'status':'in_progress'}
                    }
                }}
            }
            statefile=temp/'state.json'
            statefile.write_text(json.dumps(state))
            for path in (manifest,artifact,candidate,statefile): os.chmod(path,0o644)
            subprocess.run(['sudo','-n','install','-d','-o','root','-g','root','-m','711',str(policy)],check=True)
            subprocess.run(['sudo','-n','install','-o','root','-g','root','-m','644','/dev/null',
                            str(policy/'owner-broker-required')],check=True)

            def tuple_of(op, pipeline='all', stage='approval'):
                result=agent('tuple',statefile,op,pipeline,stage)
                self.assertEqual(result.returncode,0,result.stderr)
                return json.loads(result.stdout)
            def check(op, receipt, pipeline='all', stage='approval', expected=True):
                result=agent('verify',statefile,op,pipeline,stage,receipt)
                if expected:
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertIn('BROKER_RECEIPT_PASS',result.stdout)
                else: self.assertNotEqual(result.returncode,0,'forged checkpoint incorrectly authorized')

            def grant(cp):
                req=self.sock(RUN_ROOT/'agent.sock',{'action':'submit','checkpoint':cp},as_user='opencode')
                self.assertEqual(req.returncode,0,req.stderr)
                rid=json.loads(req.stdout)['ok']['id']
                check(cp['operation'],'0'*32,cp['pipeline_id'],cp['stage'],False)
                owner=self.sock(RUN_ROOT/'owner.sock',{'action':'approve','request_id':rid},as_user='root')
                self.assertEqual(json.loads(owner.stdout)['ok']['decision'],'approved')
                consumed=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':cp},as_user='opencode')
                self.assertTrue(json.loads(consumed.stdout)['ok']['authorized'])
                return rid

            plan=tuple_of('plan.final_manifest.approve')
            plan_id=grant(plan)
            check('plan.final_manifest.approve',plan_id)
            owner_tuple=tuple_of('owner.accept','p1','owner')
            owner_id=grant(owner_tuple)
            check('owner.accept',owner_id,'p1','owner')
            state['pipelines']['p1']['stages']['owner']={'status':'completed','evidence':{'owner_approval_request_id':owner_id}}
            statefile.write_text(json.dumps(state))
            check('owner.accept',owner_id,'p1','owner')  # immutable across stage completion
            check('owner.accept',plan_id,'p1','owner',False) # wrong operation receipt
            artifact.write_text('{"status":"FAIL"}')
            check('owner.accept',owner_id,'p1','owner',False)
            artifact.write_text('{"status":"PASS"}')
            candidate.write_text(json.dumps({'candidate_sha':'b'*40}))
            check('owner.accept',owner_id,'p1','owner',False)
            candidate.write_text(json.dumps({'candidate_sha':'a'*40}))
            check('owner.accept',owner_id,'p1','owner')
        finally:
            subprocess.run(['sudo','-n','chmod','711',str(policy)],check=False)
            subprocess.run(['sudo','-n','rm','-rf',str(policy)],check=False)
            shutil.rmtree(temp,ignore_errors=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls,'proc'):
            cls.proc.terminate()
            try: cls.proc.wait(timeout=8)
            except subprocess.TimeoutExpired: cls.proc.kill();cls.proc.wait()
        subprocess.run(['sudo','-n','rm','-rf',str(RUN_ROOT),str(DATA_ROOT),'/usr/local/lib/my-opencode/opencode-owner-approvald.py','/usr/local/lib/my-opencode/opencode-owner-approval.py','/usr/local/lib/my-opencode/owner-broker-client.mjs'],check=False)
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
        owner=self.sock(RUN_ROOT/'owner.sock',{'action':'approve','request_id':rid},as_user='root')
        self.assertEqual(json.loads(owner.stdout)['ok']['decision'],'approved')
        consumed=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':cp},as_user='opencode')
        self.assertTrue(json.loads(consumed.stdout)['ok']['authorized'])
        tampered={**cp,'manifest_sha256':'b'*64}
        mismatch=self.sock(RUN_ROOT/'agent.sock',{'action':'consume','request_id':rid,'checkpoint':tampered},as_user='opencode')
        self.assertEqual(json.loads(mismatch.stdout)['error'],'CHECKPOINT_MISMATCH')
        self.assertEqual(int(subprocess.check_output(['sudo','-n','stat','-c','%a',str(DATA_ROOT/'ledger.sqlite3')],text=True).strip(),8)&0o077,0)
        self.assertEqual((RUN_ROOT/'owner.sock').stat().st_mode&0o077,0)
if __name__=='__main__':unittest.main()