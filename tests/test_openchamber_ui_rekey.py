#!/usr/bin/env python3
"""Test preservation of passkey material but revocation of old agent-readable cookies."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[0] / 'rekey-openchamber-ui.py'
spec = importlib.util.spec_from_file_location('oc_rekey', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RekeyTests(unittest.TestCase):
    def test_rekey_strips_old_secrets_and_preserves_passkeys(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)
            (d/'startup.env').write_text('OPENCHAMBER_UI_PASSWORD=compromised\nOPENCODE_HOST=http://evil\nOTHER_SETTING=keep\nOPENCHAMBER_APPROVAL_SOCKET=/tmp/agent.sock\n')
            (d/'jwt-secret').write_text('compromised-jwt')
            (d/'ui-passkeys.json').write_text(json.dumps({'passwordBinding':'old','passkeys':[{'id':'pk1','publicKey':'PK'}]}))
            result=module.rekey(d,test=True)
            self.assertEqual(result['status'],'rekeyed')
            self.assertEqual(result['passkeys_preserved'],1)
            new_env=(d/'startup.env').read_text()
            self.assertIn('OTHER_SETTING=keep',new_env)
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