"""Blaxel orchestration tests; all cloud calls are mocked."""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import app, cli, config, pipeline, runner


class BlaxelFlowTest(unittest.TestCase):
    def job(self, root: str):
        return pipeline.new_job(pipeline.Request(task_ids=["task"]), [], None,
                                name="test-run", jobs_dir=Path(root), workspace="eval-only",
                                image="test-image", region="us-pdx-1")

    def test_job_records_execution_target(self):
        with tempfile.TemporaryDirectory() as root:
            job = self.job(root)
            self.assertEqual(job.meta["backend"], "blaxel")
            self.assertEqual(job.meta["workspace"], "eval-only")
            self.assertEqual(job.meta["image"], "test-image")
            self.assertEqual(job.meta["region"], "us-pdx-1")

    def test_job_resolves_configured_workspace(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
                pipeline.runtime, "workspace", return_value="eval-config") as workspace:
            job = pipeline.new_job(pipeline.Request(), [], None, name="run", jobs_dir=Path(root))
        workspace.assert_called_once_with()
        self.assertEqual(job.meta["workspace"], "eval-config")

    def test_resume_restores_target_not_ambient_defaults(self):
        settings = runner.Settings(image="another-image")
        meta = {"backend": "blaxel", "workspace": "eval-original", "image": "original-image",
                "region": "us-pdx-1"}
        with mock.patch.dict(os.environ, {"PR_EVAL_BLAXEL_WORKSPACE": "eval-other"}):
            pipeline.restore_execution(meta, settings)
            self.assertEqual(os.environ["PR_EVAL_BLAXEL_WORKSPACE"], "eval-original")
        self.assertEqual(settings.workspace, "eval-original")
        self.assertEqual(settings.image, "original-image")

    def test_resume_keeps_the_sandbox_size_the_run_started_with(self):
        with mock.patch.dict(os.environ):
            new = {"backend": "blaxel", "workspace": "eval-only", "image": "image"}
            pipeline.restore_execution(new, runner.Settings(memory=16384))
            resumed = runner.Settings()
            pipeline.restore_execution(new, resumed)
            raised = runner.Settings(memory=32768)
            pipeline.restore_execution(new, raised)
        self.assertEqual(resumed.memory, 16384)
        self.assertEqual((raised.memory, new["memory"]), (32768, 32768))

    def test_resume_rejects_docker_and_incomplete_metadata(self):
        for meta in ({"image": "legacy:dev"}, {"backend": "docker"}, {"backend": "blaxel"}):
            with self.subTest(meta=meta), self.assertRaisesRegex(SystemExit, "start a new run"):
                pipeline.restore_execution(meta, runner.Settings())

    def test_resume_rejects_explicit_workspace_change(self):
        with self.assertRaisesRegex(SystemExit, "differs"):
            pipeline.restore_execution({"backend": "blaxel", "workspace": "eval-old", "image": "image"},
                                       runner.Settings(workspace="eval-new"))

    def test_first_run_builds_remotely(self):
        with mock.patch.object(pipeline.runtime, "check_connection"), \
                mock.patch.object(pipeline.runtime, "image_exists", return_value=False), \
                mock.patch.object(pipeline.runtime, "build_image", return_value=0) as build, \
                contextlib.redirect_stdout(io.StringIO()):
            pipeline.ensure_image("image")
        build.assert_called_once_with("image", None)

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
        with mock.patch.object(pipeline.runtime, "check_connection", side_effect=pipeline.runtime.RuntimeError("configure workspace")), \
                mock.patch.object(pipeline.runtime, "build_image") as build, \
                self.assertRaisesRegex(SystemExit, "configure workspace"):
            pipeline.ensure_image("image")
        build.assert_not_called()

    def test_remote_build_failure_is_not_silenced(self):
        with mock.patch.object(pipeline.runtime, "check_connection"), \
                mock.patch.object(pipeline.runtime, "image_exists", return_value=False), \
                mock.patch.object(pipeline.runtime, "build_image", return_value=1), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, "build failed"):
            pipeline.ensure_image("image")

    def test_validation_selection_uses_execution_identity(self):
        task = SimpleNamespace(id="task")
        settings = runner.Settings(workspace="eval-only")
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
                    mock.patch.object(pipeline, "image_claude_version", return_value="test"), \
                    mock.patch.object(pipeline.report, "build", return_value="report.html"), \
                    mock.patch.object(runner, "run"):
                self.assertEqual(pipeline.execute(job, [], settings), 0)
            prepare.assert_called_once_with(job, "test-image")
            check.assert_called_once_with(job, [task], settings)
            self.assertEqual(settings.workspace, "eval-only")

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

    def test_interrupted_run_cleans_up_recorded_workspace(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            job = self.job(root)
            with mock.patch.object(pipeline, "find_tasks", side_effect=KeyboardInterrupt), \
                    mock.patch.object(runner, "cleanup", return_value=[]) as cleanup, \
                    mock.patch.object(pipeline, "rebuild_quietly"):
                self.assertEqual(pipeline.execute(job, [], runner.Settings()), 130)
            cleanup.assert_called_once_with(job.id, workspace="eval-only")
            self.assertEqual(pipeline.Job(job.path).meta["status"]["phase"], "stopped")

    def test_cli_workspace_memory_and_keep_sandboxes(self):
        with mock.patch.dict(os.environ), mock.patch.object(cli, "cmd_run", return_value=0) as run:
            self.assertEqual(cli.main(["run", "--workspace", "eval-cli", "--memory", "8192",
                                       "--keep-sandboxes"]), 0)
            args = run.call_args.args[0]
            self.assertEqual(args.memory, 8192)
            self.assertTrue(args.keep_sandboxes)
            self.assertEqual(os.environ["PR_EVAL_BLAXEL_WORKSPACE"], "eval-cli")
            self.assertFalse(hasattr(args, "cpus"))

    def test_serve_passes_workspace_through_inherited_environment(self):
        with mock.patch.dict(os.environ), mock.patch.object(app, "serve") as serve:
            cli.main(["serve", "--workspace", "eval-page", "--no-open"])
            self.assertEqual(os.environ["PR_EVAL_BLAXEL_WORKSPACE"], "eval-page")
            self.assertFalse(serve.call_args.kwargs["open_browser"])

    def test_page_reports_connection_problem_instead_of_docker(self):
        judge = config.Judge(model="test", base_url="https://example.invalid", api_key_env="TEST_JUDGE_KEY")
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(judge, "problem", return_value="missing key"), \
                mock.patch.object(app.runtime, "check_connection", side_effect=app.runtime.RuntimeError("workspace missing")), \
                mock.patch.object(app.shutil, "which", return_value=None):
            checks = app.App(Path(root)).checks(judge)
        self.assertFalse(checks["blaxel"])
        self.assertEqual(checks["blaxel_problem"], "workspace missing")
        self.assertNotIn("docker", checks)

    def test_page_checks_work_without_build_cli(self):
        judge = config.Judge(model="test", base_url="https://example.invalid", api_key_env="TEST_JUDGE_KEY")
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(judge, "problem", return_value=None), \
                mock.patch.object(app.runtime, "check_connection"), \
                mock.patch.object(app.pipeline, "image_exists") as image_exists, \
                mock.patch.object(app.shutil, "which", return_value=None):
            checks = app.App(Path(root)).checks(judge)
        self.assertTrue(checks["blaxel"])
        self.assertFalse(checks["bl_cli"])
        self.assertFalse(checks["image"])
        image_exists.assert_not_called()

    def test_page_blocks_first_build_without_cli(self):
        with tempfile.TemporaryDirectory() as root:
            page = app.App(Path(root))
            with mock.patch.object(page, "state", return_value={"busy": False, "checks": {
                    "blaxel": True, "image": False, "bl_cli": False}}):
                self.assertIn("Blaxel CLI", page.start({})["error"])

    def test_legacy_report_is_viewable_but_not_resumable(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "legacy"
            path.mkdir()
            (path / "run.json").write_text(json.dumps({"run_id": "legacy", "request": {"repos": ["owner/repo"]},
                                                      "status": {"phase": "stopped"}}))
            result = app.App(Path(root)).describe(path)
        self.assertEqual(result["phase"], "stopped")
        self.assertFalse(result["resumable"])


if __name__ == "__main__":
    unittest.main()
