#!/usr/bin/env python3
"""Behavioral contracts for the real OpenChamber cutover process inventory."""
import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'scripts/check-openchamber-quiescence.py'
spec = importlib.util.spec_from_file_location('oc_quiescence', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Quiescence(unittest.TestCase):
    base = '1 0 0\n150 1 1001\n200 1 0\n300 1 1001\n'

    def test_empty_services_are_safe(self):
        self.assertTrue(module.check(self.base, [(0,1001),(0,0)]))
        self.assertTrue(module.check(self.base, [(150,1001),(200,0)]))

    def test_live_terminal_blocks_cutover(self):
        with self.assertRaisesRegex(module.QuiescenceError, 'LIVE_OPENCHAMBER_CHILD'):
            module.check(self.base+'250 150 1001\n251 250 1001\n',[(150,1001),(0,0)])

    def test_live_root_guest_blocks_upgrade(self):
        with self.assertRaisesRegex(module.QuiescenceError, 'LIVE_OPENCHAMBER_CHILD'):
            module.check(self.base+'245 200 1001\n',[(150,1001),(200,0)])

    def test_wrong_owner_or_missing_pid_is_fail_closed(self):
        with self.assertRaisesRegex(module.QuiescenceError,'SERVICE_PID_UNTRUSTED'):
            module.check(self.base,[(150,0)])
        with self.assertRaisesRegex(module.QuiescenceError,'SERVICE_PID_UNTRUSTED'):
            module.check(self.base,[(456,1001)])

    def test_invalid_inventory_is_rejected(self):
        for bad in ['', 'garbage\n', '3 1 0\n3 1 0\n', 'a 1 0\n']:
            with self.subTest(bad=bad), self.assertRaises(module.QuiescenceError):
                module.check(bad,[(0,1001)])

if __name__ == '__main__':
    unittest.main()
