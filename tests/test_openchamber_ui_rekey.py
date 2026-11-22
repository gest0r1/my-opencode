#!/usr/bin/env python3
"""Test preservation of passkey material but revocation of old agent-readable cookies."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'rekey-openchamber-ui.py'
spec = importlib.util.spec_from_file_location('oc_rekey', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RekeyTests(unittest.TestCase):
    def test_rekey_strips_old_secrets_and_preserves_passkeys(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)
            (d/'startup.env').write_text('OPENCHAMBER_UI_PASSWORD=compromised\nOPENCODE_HOST=http://evil\nOTHER_SETTING=keep\nOPENCHAMBER_APPROVAL_SOCKET=/tmp/agent.sock\nLD_PRELOAD=/tmp/opencode-malware.so\nNODE_OPTIONS=--require=/home/opencode/malware.cjs\nPATH=/home/opencode/bin\nOPENCHAMBER_BIND_HOST=127.0.0.1\nOPENCHAMBER_BIND_PORT=3000\n')
            (d/'jwt-secret').write_text('compromised-jwt')
            (d/'ui-passkeys.json').write_text(json.dumps({'passwordBinding':'old','passkeys':[{'id':'pk1','publicKey':'PK'}]}))
            result=module.rekey(d,test=True)
            self.assertEqual(result['status'],'rekeyed')
            self.assertEqual(result['passkeys_preserved'],1)
            new_env=(d/'startup.env').read_text()
            self.assertNotIn('OTHER_SETTING',new_env)
            self.assertNotIn('LD_PRELOAD',new_env)
            self.assertNotIn('NODE_OPTIONS',new_env)
            self.assertNotIn('PATH=',new_env)
            self.assertIn('OPENCHAMBER_BIND_HOST=127.0.0.1',new_env)
            self.assertIn('OPENCHAMBER_BIND_PORT=3000',new_env)
            quarantine=(d/'startup.env.pre-p1').read_text()
            self.assertIn('OTHER_SETTING=keep',quarantine)
            self.assertIn('LD_PRELOAD=/tmp/opencode-malware.so',quarantine)
            self.assertEqual((d/'startup.env.pre-p1').stat().st_mode&0o077,0)
            self.assertIn('LD_PRELOAD',result['legacy_startup_keys_quarantined'])
            self.assertNotIn('compromised',new_env)
            self.assertNotIn('http://evil',new_env)
            self.assertNotIn('OPENCHAMBER_APPROVAL_SOCKET',new_env)
            self.assertNotEqual((d/'jwt-secret').read_text(),'compromised-jwt')
            pk=json.loads((d/'ui-passkeys.json').read_text())
            self.assertEqual(pk['passkeys'][0]['id'],'pk1')
            self.assertNotEqual(pk['passwordBinding'],'old')
            self.assertEqual(module.rekey(d,test=True)['status'],'already_rekeyed')
    def test_refuse_malicious_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)
            (d/'jwt-secret').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError,'SYMLINK'):
                module.rekey(d,test=True)

if __name__=='__main__': unittest.main()