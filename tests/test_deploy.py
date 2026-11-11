"""hosted/deploy.py's smoke test: what counts as an attempt that went end to end, and the page never shows it."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from eval_sandbox import app  # noqa: E402

spec = importlib.util.spec_from_file_location("deploy", ROOT / "hosted" / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

WENT = {"outcome": "failed", "invalid_reason": None, "setup": {"exit_code": 0}, "agent": {"subtype": "success"},
        "diff": {"files": 2}, "tests": {"passed": False}, "judge": {"verdict": "fail"}}


class SmokeVerdict(unittest.TestCase):
    def test_an_attempt_that_went_end_to_end_passes_whether_or_not_it_solved(self):
        self.assertIsNone(deploy.verdict({}, WENT))
        self.assertIsNone(deploy.verdict({}, {**WENT, "outcome": "solved", "judge": {"verdict": "pass"}}))
        self.assertIsNone(deploy.verdict({}, {**WENT, "agent": {"timed_out": True}}))  # stopped at its time limit

    def test_a_not_scored_attempt_fails_with_its_cause(self):
        why = deploy.verdict({}, {"outcome": "invalid", "invalid_reason": "sandbox-error"},
                             error="Could not upload source.tar.gz (OSError)")
        self.assertIn("sandbox-error", why)
        self.assertIn("Could not upload source.tar.gz (OSError)", why)

    def test_no_attempt_result_fails_with_the_run_status_and_log(self):
        why = deploy.verdict({"status": {"phase": "failed", "detail": "MemoryError"}}, {}, log="Traceback ...")
        self.assertIn("MemoryError", why)
        self.assertIn("Traceback", why)

    def test_each_missing_step_fails(self):
        for change, words in [({"agent": {}}, "agent"), ({"tests": None}, "hidden tests"),
                              ({"diff": {"files": 0}}, "changed no files"), ({"judge": {"error": "429"}}, "judges"),
                              ({"outcome": "interrupted"}, "interrupted")]:
            with self.subTest(change=change):
                self.assertIn(words, deploy.verdict({}, {**WENT, **change}))


class SmokeRunsHidden(unittest.TestCase):
    def test_the_page_lists_no_smoke_run_and_counts_none_toward_limits(self):
        with tempfile.TemporaryDirectory() as root:
            jobs = Path(root) / "jobs"
            for name, access in [("quick-1", {"owner": "a@example.com"}),
                                 ("deploy-smoke-1-before", {"owner": deploy.SMOKE_OWNER, "smoke": True})]:
                (jobs / name).mkdir(parents=True)
                (jobs / name / "access.json").write_text(json.dumps(access))
                (jobs / name / "run.json").write_text(json.dumps({"status": {"phase": "done"}, "tasks": [], "models": []}))
            with mock.patch.object(app.App, "checks", return_value={}):
                self.assertEqual([d.name for d, _ in app.App(jobs).everyone()], ["quick-1"])


if __name__ == "__main__":
    unittest.main()
