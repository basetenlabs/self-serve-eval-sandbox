"""hosted/deploy.py's smoke test: what counts as an attempt that went end to end, and the page never shows it."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
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



class FakeSandboxes:
    """The management API as host() sees it: one sandbox record and the volume it mounts."""

    def __init__(self, status, attached_polls):
        self.box = {"name": deploy.SANDBOX, "status": status, "created_at": "2026-11-11T06:15:17Z"}
        self.attached_polls, self.calls = attached_polls, []

    def volume(self, *args):
        return {}

    def get(self, name):
        return self.box

    def delete(self, name):
        self.calls.append("delete")
        self.box = None

    def manage(self, method, path, body=None, allow=()):
        self.attached_polls -= 1
        return {"attached_to": deploy.SANDBOX} if self.attached_polls >= 0 else {}

    def create(self, body):
        self.calls.append(("create", self.attached_polls))
        self.box = {"name": deploy.SANDBOX, "status": "DEPLOYED"}
        return self.box

    def preview(self, sandbox, name, port):
        return f"https://{name}"


class HostRecovery(unittest.TestCase):
    def host(self, status, renew=False):
        fake = FakeSandboxes(status, attached_polls=2)
        with mock.patch.object(deploy, "CLIENT", fake), mock.patch.object(deploy, "image", lambda: "img"), \
                mock.patch.object(deploy, "ready", lambda box: None), mock.patch.object(deploy.time, "sleep"):
            _, _, _, created = deploy.host(renew=renew)
        return fake, created

    def test_a_failed_sandbox_is_deleted_and_created_once_its_volume_is_free(self):
        fake, created = self.host("FAILED")
        self.assertTrue(created)
        self.assertEqual(fake.calls, ["delete", ("create", -1)])

    def test_a_deployed_sandbox_is_kept(self):
        fake, created = self.host("DEPLOYED")
        self.assertFalse(created)
        self.assertEqual(fake.calls, [])

class SignInAcrossReleases(unittest.TestCase):
    def test_every_release_gives_the_sign_in_the_same_access_file_on_the_volume(self):
        # @blaxel/sign-in ends every session when the access file's path changes; a release's own data/ link
        # (releases/<id>/data/access.json) changed it on each deploy and signed everyone out.
        started = []
        fake = mock.Mock(processes=lambda sandbox: [], start=lambda sandbox, name, **kw: started.append((name, kw)))
        with mock.patch.object(deploy, "CLIENT", fake), mock.patch.object(deploy, "serving"), \
                mock.patch.object(deploy, "mail_key", return_value=None), mock.patch.object(deploy, "keychain", return_value=None):
            for release in [f"{deploy.RELEASES}/20261111-080000-aaaaaaa", f"{deploy.RELEASES}/20261111-081500-d131a6e"]:
                deploy.start("box", "https://eval.example", "https://meter.example", {}, release)
        files = [kw["env"]["AUTH_ACCESS_FILE"] for name, kw in started if name.startswith("pr-eval-sign-in")]
        self.assertEqual(files, ["/data/app/data/access.json"] * 2)


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


class UnverifiedRelease(unittest.TestCase):
    """A deploy killed after its release went live, before the smoke test on the live page (T-859)."""

    def finish(self, left, live, smoke_fails=False):
        calls = []

        def smoke(*args):
            calls.append(("smoke", args[1], args[-1]))
            if smoke_fails:
                raise deploy.SmokeFailed("judges failed")

        with mock.patch.object(deploy, "remote_json", lambda box, path: left), \
                mock.patch.object(deploy, "live_release", lambda box: live), \
                mock.patch.object(deploy, "run", lambda box, cmd: calls.append(cmd)), \
                mock.patch.object(deploy, "verify", lambda *a: None), \
                mock.patch.object(deploy, "smoke", smoke), \
                mock.patch.object(deploy, "switch", lambda box, rel: calls.append(("switch", rel))), \
                mock.patch.object(deploy, "start", lambda *a: calls.append(("start", a[-1]))):
            return deploy.finish_unverified({}, "https://web", "https://meter", {}), calls

    def test_nothing_left_runs_nothing(self):
        self.assertEqual(self.finish({}, "/data/app/releases/a"), (True, []))

    def test_the_live_release_gets_its_smoke_test_then_the_marker_goes(self):
        ok, calls = self.finish({"release": "r/new", "previous": "r/old", "task": "t"}, "r/new")
        self.assertTrue(ok)
        self.assertEqual(calls, [("smoke", "r/new", "after"), f"rm -f {deploy.UNVERIFIED}"])

    def test_a_failed_smoke_test_rolls_back(self):
        ok, calls = self.finish({"release": "r/new", "previous": "r/old", "task": "t"}, "r/new", smoke_fails=True)
        self.assertFalse(ok)
        self.assertEqual(calls[1:], [("switch", "r/old"), ("start", "r/old"), f"rm -f {deploy.UNVERIFIED}"])

    def test_a_release_no_longer_live_only_drops_the_marker(self):
        ok, calls = self.finish({"release": "r/new", "previous": "r/old", "task": "t"}, "r/old")
        self.assertEqual((ok, calls), (True, [f"rm -f {deploy.UNVERIFIED}"]))


class SmokeRunsPruned(unittest.TestCase):
    def test_only_marked_smoke_runs_older_than_the_newest_few_are_listed_for_removal(self):
        with tempfile.TemporaryDirectory() as root:
            jobs = Path(root)
            runs = [("smoke-1-before", {"smoke": True}), ("smoke-1-after", {"smoke": True}),
                    ("smoke-2-before", {"smoke": True}), ("smoke-2-after", {"smoke": True}),
                    ("smoke-20261111-101500", {"owner": "a@example.com"}),  # a person's run on a repository named "smoke"
                    ("smoke-9-unmarked", None), ("quick-1", {"owner": "a@example.com", "smoke": True})]
            for age, (name, access) in enumerate(runs):
                (jobs / name).mkdir()
                if access is not None:
                    (jobs / name / "access.json").write_text(json.dumps(access))
                os.utime(jobs / name, (1_700_000_000 + age, 1_700_000_000 + age))  # listed oldest first
            listed = subprocess.run([sys.executable, "-c", deploy.OLD_SMOKE, str(jobs), "2"], capture_output=True,
                                    text=True, check=True).stdout.split()
            self.assertEqual(sorted(Path(p).name for p in listed), ["smoke-1-after", "smoke-1-before"])


class SmokeStaysAwake(unittest.TestCase):
    def test_the_smoke_run_keeps_its_sandbox_awake_whoever_is_watching(self):
        """A sandbox nobody calls goes on standby, which pauses a run inside it while its attempt's sandboxes go
        on: with the deploying machine stalled, a paused run found its agent ended and took it for a crash."""
        import inspect
        started = inspect.getsource(deploy.smoke)
        self.assertIn('"keepAlive": True', started)
        self.assertIn('"timeout": SMOKE_TIMEOUT', started)  # and bounded: awake no longer than the run may take


class PageSandboxes(unittest.TestCase):
    def test_the_pages_runs_make_their_sandboxes_with_the_deploys_key_in_its_team(self):
        """Nobody connects a workspace of their own: every run's sandboxes are in the page's Baseten team."""
        from types import SimpleNamespace
        deployer = SimpleNamespace(key="can-make-sandboxes", team="team-one")
        with mock.patch.object(deploy, "client", return_value=deployer), mock.patch.object(deploy, "keychain", return_value=None):
            env = deploy.page_env({"BASETEN_API_KEY": "model-only"}, "https://page.example", "https://meter.example", 8766)
            deployer.team = None
            default_team = deploy.page_env({}, "https://page.example", "https://meter.example", None)
        self.assertEqual((env["BASETEN_SANDBOX_API_KEY"], env["BASETEN_TEAM_ID"], env["BASETEN_API_KEY"]),
                         ("can-make-sandboxes", "team-one", "model-only"))
        self.assertNotIn("BASETEN_TEAM_ID", default_team)  # the key's own team
        for settings in (env, deploy.SECRETS):
            self.assertFalse([name for name in settings if name.startswith("BL_") or "BLAXEL" in name])


if __name__ == "__main__":
    unittest.main()
