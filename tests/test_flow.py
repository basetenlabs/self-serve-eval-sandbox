"""Orchestration tests for the trial sandboxes; every call to Baseten is mocked."""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import app, cli, config, pipeline, runner


class FlowTest(unittest.TestCase):
    def job(self, root: str):
        return pipeline.new_job(pipeline.Request(task_ids=["task"]), [], None,
                                name="test-run", jobs_dir=Path(root), image="test-image", region="us-pdx-1")

    def test_job_records_execution_target(self):
        with tempfile.TemporaryDirectory() as root:
            job = self.job(root)
            self.assertEqual(job.meta["backend"], "baseten")
            self.assertEqual(job.meta["image"], "test-image")
            self.assertEqual(job.meta["region"], "us-pdx-1")
            self.assertNotIn("workspace", job.meta)  # nobody connects or names one: the key's team is where it runs

    def test_resume_restores_target_not_ambient_defaults(self):
        settings = runner.Settings(image="another-image", region="eu-west-1")
        meta = {"backend": "baseten", "image": "original-image", "region": "us-pdx-1"}
        pipeline.restore_execution(meta, settings)
        self.assertEqual((settings.image, settings.region), ("original-image", "us-pdx-1"))

    def test_resume_keeps_the_sandbox_size_the_run_started_with(self):
        with mock.patch.dict(os.environ):
            new = {"backend": "baseten", "image": "image"}
            pipeline.restore_execution(new, runner.Settings(memory=16384))
            resumed = runner.Settings()
            pipeline.restore_execution(new, resumed)
            raised = runner.Settings(memory=32768)
            pipeline.restore_execution(new, raised)
        self.assertEqual(resumed.memory, 16384)
        self.assertEqual((raised.memory, new["memory"]), (32768, 32768))

    def test_a_run_from_another_backend_is_not_resumed(self):
        """Its checks and its attempts' sandboxes were somewhere else: its report stays, and a new run replaces it."""
        for meta in ({"image": "legacy:dev"}, {"backend": "docker"}, {"backend": "baseten"},
                     {"backend": "blaxel", "workspace": "eval-only", "image": "sandbox/image:one"}):
            with self.subTest(meta=meta), self.assertRaisesRegex(SystemExit, "start a new run"):
                pipeline.restore_execution(meta, runner.Settings())

    def test_first_run_builds_remotely(self):
        with mock.patch.object(pipeline.runtime, "check_connection"), \
                mock.patch.object(pipeline.runtime, "image_exists", return_value=False), \
                mock.patch.object(pipeline.runtime, "build_image", return_value=0) as build, \
                contextlib.redirect_stdout(io.StringIO()):
            pipeline.ensure_image("image")
        build.assert_called_once_with("image")

    def test_preparation_pins_immutable_image_before_validation(self):
        with tempfile.TemporaryDirectory() as root:
            job = self.job(root)
            with mock.patch.object(pipeline, "ensure_image"), \
                    mock.patch.object(pipeline.runtime, "resolve_image", return_value="registry/image@sha256:abc"):
                self.assertEqual(pipeline.prepare_image(job, "test-image"), "registry/image@sha256:abc")
            saved = pipeline.Job(job.path)
            self.assertEqual(saved.meta["image"], "registry/image@sha256:abc")
            self.assertEqual(saved.meta["image_source"], "test-image")

    def test_existing_image_is_reused(self):
        with mock.patch.object(pipeline.runtime, "check_connection"), \
                mock.patch.object(pipeline.runtime, "image_exists", return_value=True), \
                mock.patch.object(pipeline.runtime, "build_image") as build:
            pipeline.ensure_image("image")
        build.assert_not_called()

    def test_missing_connection_fails_before_build(self):
        with mock.patch.object(pipeline.runtime, "check_connection", side_effect=pipeline.runtime.RuntimeError("set a key")), \
                mock.patch.object(pipeline.runtime, "build_image") as build, \
                self.assertRaisesRegex(SystemExit, "set a key"):
            pipeline.ensure_image("image")
        build.assert_not_called()

    def test_remote_build_failure_is_not_silenced(self):
        with mock.patch.object(pipeline.runtime, "check_connection"), \
                mock.patch.object(pipeline.runtime, "image_exists", return_value=False), \
                mock.patch.object(pipeline.runtime, "build_image", return_value=1), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, "didn't build"):
            pipeline.ensure_image("image")

    def test_validation_selection_uses_execution_identity(self):
        task = SimpleNamespace(id="task")
        settings = runner.Settings()
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()):
            job = self.job(root)
            with mock.patch.object(runner, "validate_all"), \
                    mock.patch.object(runner, "validation_status", return_value="valid") as status:
                self.assertEqual(pipeline.check(job, [task], settings), [task])
        status.assert_called_once_with(task, settings)

    def test_resume_rechecks_validation_in_recorded_environment(self):
        task = SimpleNamespace(id="task")
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            job = self.job(root)
            job.meta["tasks"] = ["task"]
            settings = runner.Settings(image="ambient-image")
            with mock.patch.object(pipeline.tasks, "discover", return_value=[task]), \
                    mock.patch.object(pipeline, "prepare_image", return_value="test-image") as prepare, \
                    mock.patch.object(pipeline, "check", return_value=[task]) as check, \
                    mock.patch.object(pipeline.report, "build", return_value="report.html"), \
                    mock.patch.object(runner, "run"):
                self.assertEqual(pipeline.execute(job, [], settings), 0)
            prepare.assert_called_once_with(job, "test-image")
            check.assert_called_once_with(job, [task], settings)
            self.assertEqual(settings.image, "test-image")

    def test_resume_does_not_silently_drop_invalid_tasks(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            job = self.job(root)
            job.meta["tasks"] = ["task"]
            with mock.patch.object(pipeline.tasks, "discover", return_value=[SimpleNamespace(id="task")]), \
                    mock.patch.object(pipeline, "prepare_image"), \
                    mock.patch.object(pipeline, "check", return_value=[]), \
                    mock.patch.object(runner, "run") as run, \
                    self.assertRaisesRegex(SystemExit, "original task set"):
                pipeline.execute(job, [], runner.Settings())
            run.assert_not_called()
            self.assertEqual(job.meta["tasks"], ["task"])

    def test_interrupted_run_removes_its_own_sandboxes(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            job = self.job(root)
            with mock.patch.object(pipeline, "find_tasks", side_effect=KeyboardInterrupt), \
                    mock.patch.object(runner, "cleanup", return_value=[]) as cleanup, \
                    mock.patch.object(pipeline, "rebuild_quietly"):
                self.assertEqual(pipeline.execute(job, [], runner.Settings()), 130)
            cleanup.assert_called_once_with(job.id)
            self.assertEqual(pipeline.Job(job.path).meta["status"]["phase"], "stopped")

    def test_cli_memory_and_keep_sandboxes_and_no_workspace_to_choose(self):
        with mock.patch.object(cli, "cmd_run", return_value=0) as run:
            self.assertEqual(cli.main(["run", "--memory", "8192", "--keep-sandboxes"]), 0)
            args = run.call_args.args[0]
            self.assertEqual(args.memory, 8192)
            self.assertTrue(args.keep_sandboxes)
            self.assertFalse(hasattr(args, "cpus"))
            self.assertFalse(hasattr(args, "workspace"))
        for command in ("run", "serve", "validate", "cleanup", "build-image"):
            with self.subTest(command), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cli.main([command, "--workspace", "anything"])

    def test_each_validation_stops_only_its_own_sandboxes(self):
        """Everyone's sandboxes are in one team: a check's are told apart by a name of the check's own."""
        seen = []
        with mock.patch.object(cli.pipeline, "ensure_image"), mock.patch.object(cli.tasks, "discover", return_value=[]), \
                mock.patch.object(cli.config, "load", return_value=(None, None)), \
                mock.patch.object(cli.runner, "in_parallel", side_effect=lambda jobs, work, workers, run_id, *_: seen.append(run_id)), \
                contextlib.redirect_stdout(io.StringIO()):
            cli.main(["validate"])
            cli.main(["validate"])
        self.assertEqual(len(set(seen)), 2)
        self.assertTrue(all(run_id.startswith("validate-") for run_id in seen))

    def test_cleanup_removes_only_what_this_folders_finished_runs_left(self):
        def run(root, name, phase, pid):
            (Path(root) / name).mkdir()
            (Path(root) / name / "run.json").write_text(json.dumps({"run_id": name, "status": {"phase": phase, "pid": pid}}))
        up = {"killed": ["a", "b"], "going": ["c"], "another-checkouts": ["d"], "validate-1": ["e"]}
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(pipeline.runtime, "trial_sandboxes", return_value=up), \
                mock.patch.object(pipeline.runtime, "cleanup", side_effect=lambda run_id: up[run_id]) as cleanup, \
                mock.patch.object(pipeline, "alive", side_effect=lambda pid: pid == 2):
            run(root, "killed", "running", 1)  # its process is gone
            run(root, "going", "running", 2)
            removed, kept = pipeline.leftover_sandboxes(Path(root))
            self.assertEqual((removed, kept), (["a", "b"], {"going": 1, "another-checkouts": 1, "validate-1": 1}))
            cleanup.assert_called_once_with("killed")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cli.main(["cleanup", "--jobs", root])
                self.assertIn("removed 2 sandbox(es)", out.getvalue())
                self.assertIn("pr-eval cleanup --run-id validate-1", out.getvalue())
                cli.main(["cleanup", "--run-id", "validate-1"])  # said by name, a run's are removed wherever it ran from
            self.assertEqual([c.args for c in cleanup.call_args_list][-1], ("validate-1",))

    def test_page_reports_connection_problem_instead_of_docker(self):
        judge = config.Panel([config.Judge(model="test", base_url="https://example.invalid", api_key_env="TEST_JUDGE_KEY")])
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(judge, "problem", return_value="missing key"), \
                mock.patch.object(app.runtime, "check_connection", side_effect=app.runtime.RuntimeError("no key set")), \
                mock.patch.object(app.runtime, "image_exists") as image_exists:
            checks = app.App(Path(root)).checks(judge)
        self.assertFalse(checks["sandboxes"])
        self.assertEqual(checks["sandboxes_problem"], "no key set")
        self.assertFalse(checks["image"])
        image_exists.assert_not_called()
        for gone in ("docker", "blaxel", "bl_cli"):
            self.assertNotIn(gone, checks)

    def test_page_checks_need_no_cli_for_the_sandboxes(self):
        judge = config.Panel([config.Judge(model="test", base_url="https://example.invalid", api_key_env="TEST_JUDGE_KEY")])
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(judge, "problem", return_value=None), \
                mock.patch.object(app.runtime, "check_connection"), \
                mock.patch.object(app.runtime, "image_exists", return_value=True), \
                mock.patch.object(app.shutil, "which", return_value=None):
            checks = app.App(Path(root)).checks(judge)
        self.assertTrue(checks["sandboxes"])
        self.assertTrue(checks["image"])

    def test_page_answers_from_the_last_check_while_it_checks_again(self):
        judge = config.Panel([config.Judge(model="test", base_url="https://example.invalid", api_key_env="TEST_JUDGE_KEY")])
        with tempfile.TemporaryDirectory() as root:
            page = app.App(Path(root))
            page.checked = (0.0, {"sandboxes": True, "sandboxes_problem": None, "gh": True,
                                  "gh_login": "before", "image": True, "judge": None})  # long out of date
            go = threading.Event()

            def slow(_judge):
                go.wait(5)
                page.checked = (app.time.monotonic(), {**page.checked[1], "gh_login": "after"})
                return page.checked[1]

            with mock.patch.object(page, "check", side_effect=slow) as check:
                self.assertEqual(page.checks(judge)["gh_login"], "before")  # no waiting on GitHub or Baseten
                self.assertEqual(page.checks(judge)["gh_login"], "before")  # and one check at a time
                go.set()
                with page.checking:  # the check in the background has finished
                    pass
                self.assertEqual(page.checks(judge)["gh_login"], "after")
            self.assertEqual(check.call_count, 1)

    def test_page_does_not_start_a_run_it_has_no_sandboxes_for(self):
        with tempfile.TemporaryDirectory() as root:
            page = app.App(Path(root))
            with mock.patch.object(page, "state", return_value={"busy": False, "checks": {
                    "sandboxes": False, "sandboxes_problem": "This Baseten key can't create sandboxes.", "image": False}}):
                self.assertEqual(page.start({})["error"], "This Baseten key can't create sandboxes.")

    def test_an_earlier_backends_report_is_viewable_but_not_resumable(self):
        for name, backend in (("legacy", {}), ("on-blaxel", {"backend": "blaxel", "workspace": "eval-only"})):
            with self.subTest(name), tempfile.TemporaryDirectory() as root:
                path = Path(root) / name
                path.mkdir()
                (path / "run.json").write_text(json.dumps({"run_id": name, "request": {"repos": ["owner/repo"]},
                                                          "status": {"phase": "stopped"}, **backend}))
                result = app.App(Path(root)).describe(path)
            self.assertEqual(result["phase"], "stopped")
            self.assertFalse(result["resumable"])

    def test_a_finished_run_with_attempts_lost_to_infrastructure_can_be_resumed(self):
        def describe(root, path, trials):
            (path / "report.json").write_text(json.dumps({"models": [], "summary": {}, "trials": trials}))
            return app.App(Path(root)).describe(path)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "done"
            path.mkdir()
            (path / "run.json").write_text(json.dumps({
                "run_id": "done", "request": {"repos": ["owner/repo"]}, "tasks": ["owner__repo-1"], "models": [],
                "backend": "baseten", "status": {"phase": "done"}}))
            lost = describe(root, path, [{"outcome": "solved"}, {"outcome": "invalid", "invalid_reason": "sandbox-error"}])
            graded = describe(root, path, [{"outcome": "invalid", "invalid_reason": "verifier-apply-error"}])
        self.assertEqual((lost["lost"], lost["resumable"]), (1, True))
        self.assertEqual((graded["lost"], graded["resumable"]), (0, False))


if __name__ == "__main__":
    unittest.main()
