"""Shared test cases (tests/cases.json) against scripts/ogd_monitor.py.

The same cases run against src/rules.mjs in tests/cases.test.mjs, so that the scheduled check
and the live status in the browser rate the same way.
Run: python3 -m unittest discover -s tests
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import ogd_monitor as m  # noqa: E402

with open(os.path.join(HERE, "cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)
with open(os.path.join(HERE, "..", "config.json"), encoding="utf-8") as f:
    CONFIG = {c["key"]: c for c in json.load(f)["items"]}


def item(v):
    return CONFIG[v] if isinstance(v, str) else v


def t(s):
    return m.parse_iso(s) if s else None


class SharedCases(unittest.TestCase):
    def test_classify(self):
        for c in CASES["classify"]:
            with self.subTest(c["name"]):
                status, value = m.classify(item(c["item"]), t(c["now"]), t(c.get("updated")),
                                           t(c.get("ref")), t(c.get("available")))
                self.assertEqual(status, c["expect"]["status"])
                if c["expect"]["value"] is None:
                    self.assertIsNone(value)
                else:
                    self.assertAlmostEqual(value, c["expect"]["value"], delta=0.1)

    def test_pause_end(self):
        for c in CASES["pause_end"]:
            with self.subTest(c["name"]):
                self.assertEqual(m.iso(m.pause_end(item(c["item"]), t(c["now"]))), c["expect"])

    def test_ref_time_from_name(self):
        for c in CASES["ref_time_from_name"]:
            with self.subTest(c["name"]):
                if c["expect"] == "error":
                    with self.assertRaises(ValueError):
                        m.ref_time_from_name(c["file"], c["source"])
                else:
                    self.assertEqual(m.iso(m.ref_time_from_name(c["file"], c["source"])), c["expect"])

    def test_parse_ref(self):
        for c in CASES["parse_ref"]:
            with self.subTest(c["value"]):
                self.assertEqual(m.iso(m.parse_ref(c["value"])), c["expect"])

    def test_select_run(self):
        for c in CASES["select_run"]:
            with self.subTest(c["name"]):
                runs = {t(k): [t(v) for v in vs] for k, vs in c["runs"].items()}
                ref, available, run = m.select_run(runs, t(c["now"]), c["ok_max_min"])
                got = {"ref": m.iso(ref), "available": m.iso(available), "run": run} if ref else None
                self.assertEqual(got, c["expect"])

    def test_config_keys_exist(self):
        for section in ("classify", "pause_end"):
            for c in CASES[section]:
                if isinstance(c["item"], str):
                    self.assertIn(c["item"], CONFIG, c["name"])


if __name__ == "__main__":
    unittest.main()
