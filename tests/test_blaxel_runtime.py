"""Offline transport/lifecycle regression tests. No SDK, Docker, network or keys."""
import builtins
import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import runner, runtime


class RuntimeTests(unittest.TestCase):
    def test_explicit_workspace_never_falls_back_to_current_cli_workspace(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(runtime, "CONFIG_PATH", Path(d) / "absent"), \
                mock.patch.dict(runtime.os.environ, {"BL_WORKSPACE": "main"}, clear=True):
            with self.assertRaises(builtins.RuntimeError):
                runtime.workspace()
            with self.assertRaises(builtins.RuntimeError):
                runtime.workspace("main")
            self.assertEqual(runtime.workspace("eval-only"), "eval-only")

    def test_build_uploads_only_image_sources_from_its_own_directory(self):
        seen = []
        def build(argv, **kwargs):
            directory = Path(kwargs["cwd"])
            seen.append(set(p.name for p in directory.iterdir()))
            self.assertEqual((directory / "Dockerfile").read_text(), (runtime.IMAGE_DIR / "Dockerfile").read_text())
            self.assertNotIn("-d", argv)
            return SimpleNamespace(returncode=0)
        with mock.patch.object(runtime, "check_connection"), mock.patch.object(runtime, "workspace", return_value="eval-only"), \
                mock.patch.object(runtime.subprocess, "run", side_effect=build):
            self.assertEqual(runtime.build_image("eval-image"), 0)
        self.assertEqual(seen, [set(runtime.IMAGE_FILES)])

    def test_latest_output_is_a_reference_not_json(self):
        with mock.patch.object(runtime, "_bl", return_value=SimpleNamespace(stdout="sandbox/eval-image:abc123\n")):
            self.assertEqual(runtime.resolve_image("eval-image"), "sandbox/eval-image:abc123")
        with mock.patch.object(runtime, "_bl") as cli:
            self.assertEqual(runtime.resolve_image("sandbox/eval-image:abc123"), "sandbox/eval-image:abc123")
            cli.assert_not_called()

    def test_failed_or_inflight_build_is_not_an_available_image(self):
        data = [{"metadata": {"name": "eval-image"}, "spec": {"tagCount": 0}}]
        with mock.patch.object(runtime, "_bl", return_value=SimpleNamespace(stdout=json.dumps(data))):
            self.assertFalse(runtime.image_exists("eval-image"))

    def test_create_declares_kernel_firewall_before_starting_any_process(self):
        api = mock.Mock()
        settings = runner.Settings(workspace="eval-only")
        with mock.patch.object(runtime, "sdk", return_value=api), \
                mock.patch.object(runtime, "execute", return_value=runtime.Execution(0, "", "")):
            runtime.create("sandbox-one", "run-one", settings)
            self.assertEqual(api.create.call_args.args[0]["memory"], 4096)
            runtime.create("sandbox-one", "run-one", settings, 16384)
        payload = api.create.call_args.args[0]
        self.assertEqual(payload["memory"], 16384)
        self.assertEqual(payload["extra_args"], {"iptables": "enabled"})
        self.assertEqual(payload["network"]["firewall"], {"rulesets": ["proxy"]})
        self.assertEqual(payload["labels"], {"pr-eval": "run-one"})
        self.assertEqual(payload["ttl"], "6h")
        self.assertNotIn("envs", payload)
        runtime._SANDBOXES.pop("sandbox-one", None)

    def test_root_or_open_local_api_fails_the_creation_guard(self):
        with mock.patch.object(runtime, "sdk", return_value=mock.Mock()), \
                mock.patch.object(runtime, "execute", return_value=runtime.Execution(1, "", "")):
            with self.assertRaisesRegex(runtime.RuntimeError, "unsafe-image .*must run non-root"):
                runtime.create("unsafe-image", "run", runner.Settings(workspace="eval-only"))
        runtime._SANDBOXES.pop("unsafe-image", None)

    def test_a_failed_creation_says_which_step_failed_but_not_what_the_api_said(self):
        api = mock.Mock()
        api.create.side_effect = ValueError("response body")
        with mock.patch.object(runtime, "sdk", return_value=api), \
                self.assertRaisesRegex(runtime.RuntimeError, r"\(ValueError\)") as raised:
            runtime.create("sandbox-one", "run", runner.Settings(workspace="eval-only"))
        self.assertNotIn("response body", str(raised.exception))
        with mock.patch.object(runtime, "sdk", return_value=mock.Mock()), \
                mock.patch.object(runtime, "execute",
                                  side_effect=runtime.RuntimeError("Blaxel process transport failed (ResponseError).")), \
                self.assertRaisesRegex(runtime.RuntimeError, r"\(Blaxel process transport failed \(ResponseError\)\.\)"):
            runtime.create("sandbox-one", "run", runner.Settings(workspace="eval-only"))
        runtime._SANDBOXES.pop("sandbox-one", None)

    def test_a_dropped_transfer_is_tried_once_more(self):
        sandbox = mock.Mock()
        sandbox.fs.write_binary.side_effect = [ConnectionResetError(), None]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(runtime, "get", return_value=sandbox), \
                mock.patch.object(runtime.time, "sleep"):
            (Path(d) / "f").write_bytes(b"x")
            runtime.upload("sb", Path(d) / "f", "/tmp/f")
            self.assertEqual(sandbox.fs.write_binary.call_count, 2)
            sandbox.fs.write_binary.side_effect = ConnectionResetError()
            with self.assertRaisesRegex(runtime.RuntimeError, "Could not upload f"):
                runtime.upload("sb", Path(d) / "f", "/tmp/f")
            sandbox.fs.read_binary.side_effect = FileNotFoundError()
            runtime.download("sb", "/logs/proxy.log", Path(d) / "p", optional=True)
            self.assertEqual(sandbox.fs.read_binary.call_count, 1)  # an optional file may simply not exist
            with self.assertRaises(runtime.RuntimeError):
                runtime.download("sb", "/workspace/.git/pr-eval.patch", Path(d) / "p")
            self.assertEqual(sandbox.fs.read_binary.call_count, 3)

    def test_failed_patch_capture_is_not_a_model_failure(self):
        with mock.patch.object(runner, "sh", return_value=(1, "git failed", False)):
            with self.assertRaises(runtime.RuntimeError):
                runner.capture_patch("sb", "a" * 40, Path("unused.patch"))

    def test_agent_never_starts_while_github_still_answers(self):
        sandbox = mock.Mock()
        sandbox.spec.network.to_dict.return_value = {"allowedDomains": ["api.anthropic.com"],
                                                     "firewall": {"rulesets": ["proxy"]}}
        api = mock.Mock(update_network=mock.Mock(return_value=sandbox))
        types = SimpleNamespace(SandboxUpdateNetwork=lambda network: network)  # no SDK needed offline
        for answer, ok in (("000", True), ("200", False)):
            with mock.patch.dict(sys.modules, {"blaxel.core.sandbox.types": types}), \
                    mock.patch.object(runtime, "sdk", return_value=api), \
                    mock.patch.object(runtime, "execute", return_value=runtime.Execution(0, answer, "")):
                if ok:
                    runtime.restrict_network("sb", ["api.anthropic.com"])
                else:
                    with self.assertRaises(runtime.RuntimeError):
                        runtime.restrict_network("sb", ["api.anthropic.com"])
        runtime._SANDBOXES.pop("sb", None)

    def test_a_stop_during_creation_still_deletes_the_new_sandbox(self):
        def create(*_):
            runner.STOPPING.set()  # the stop lands while the sandbox is being allocated
        try:
            with mock.patch.object(runtime, "create", side_effect=create):
                with self.assertRaises(runtime.RuntimeError):
                    runner.start_container("sb", "run", runner.Settings(workspace="eval-only"))
        finally:
            runner.STOPPING.clear()

    def test_cleanup_keeps_going_past_a_failed_delete(self):
        def item(name):
            return SimpleNamespace(metadata=SimpleNamespace(name=name, labels=SimpleNamespace(
                to_dict=lambda: {"pr-eval": "run"})))
        api = mock.Mock()
        api.list.return_value.auto_paging_iter.return_value = [item("a"), item("b")]
        deleted = []
        def delete(name):
            if name == "a":
                raise runtime.RuntimeError("stuck")
            deleted.append(name)
        with mock.patch.object(runtime, "sdk", return_value=api), \
                mock.patch.object(runtime, "delete", side_effect=delete):
            with self.assertRaises(runtime.RuntimeError):
                runtime.cleanup("run", "eval-only")
        self.assertEqual(deleted, ["b"])

    def test_a_failed_delete_still_records_the_check(self):
        with tempfile.TemporaryDirectory() as d:
            task = SimpleNamespace(id="public-task", path=Path(d), meta={"environment": {}})
            with mock.patch.object(runner, "start_container"), \
                    mock.patch.object(runner, "prepare_workspace", return_value=("setup-error", {})), \
                    mock.patch.object(runtime, "delete", side_effect=runtime.RuntimeError("slow delete")):
                record = runner.validate_task(task, runner.Settings(workspace="eval-only"))
            self.assertEqual(record["status"], "setup-error")
            self.assertEqual(json.loads((Path(d) / "validation" / "result.json").read_text())["status"], "setup-error")

    def test_process_transport_never_embeds_secret_values_in_command(self):
        sandbox = mock.Mock()
        sandbox.process.wait.return_value = SimpleNamespace(status="completed", exit_code=0)
        sandbox.fs.read_binary.side_effect = [b"hello", b""]
        with mock.patch.object(runtime, "get", return_value=sandbox):
            result = runtime.execute("sb", "printf hello", timeout=10, env={"TEST_KEY": "secret-value"})
        req = sandbox.process.exec.call_args.args[0]
        self.assertIn('TEST_KEY="${TEST_KEY}"', req["command"])
        self.assertNotIn("secret-value", req["command"])
        self.assertEqual(req["env"], {"TEST_KEY": "secret-value"})
        self.assertNotIn("BL_API_KEY", req["command"])
        self.assertIn("HOME=/logs/home", req["command"])
        self.assertIn("mkdir -p /logs/home", req["command"])
        self.assertIn("NODE_USE_ENV_PROXY=1", req["command"])  # else corepack can't reach npm
        self.assertTrue(req["keep_alive"])
        self.assertFalse(req["wait_for_completion"])
        self.assertEqual(result.stdout, "hello")

    def test_clean_environment_preserves_urllib_https_proxy(self):
        sandbox = mock.Mock()
        sandbox.process.wait.return_value = SimpleNamespace(status="completed", exit_code=0)
        sandbox.fs.read_binary.return_value = b""
        with tempfile.TemporaryDirectory() as d:
            out, err = str(Path(d) / "stdout"), str(Path(d) / "stderr")
            script = shlex.quote(sys.executable) + " -c " + shlex.quote(
                "import json,urllib.request; print(json.dumps(urllib.request.getproxies()))")
            with mock.patch.object(runtime, "get", return_value=sandbox):
                runtime.execute("sb", script, timeout=10, stdout_path=out, stderr_path=err)
            command = sandbox.process.exec.call_args.args[0]["command"].replace("/logs", str(Path(d) / "logs"))
            env = {k: v for k, v in os.environ.items() if k.lower() not in
                   ("https_proxy", "http_proxy", "all_proxy", "no_proxy")}
            env.update(HTTPS_PROXY="http://proxy.invalid:3128", NO_PROXY="localhost,127.0.0.1")
            subprocess.run(["bash", "-c", command], env=env, check=True)
            proxies = json.loads(Path(out).read_text())
            self.assertEqual(proxies["https"], "http://proxy.invalid:3128")
            self.assertEqual(proxies["no"], "localhost,127.0.0.1")

    def test_process_timeout_kills_then_confirms_exit(self):
        sandbox = mock.Mock()
        sandbox.process.wait.side_effect = [TimeoutError(), SimpleNamespace(status="killed", exit_code=137)]
        sandbox.fs.read_binary.side_effect = [b"partial", b""]
        with mock.patch.object(runtime, "get", return_value=sandbox):
            result = runtime.execute("sb", "sleep 20", timeout=1)
        sandbox.process.kill.assert_called_once()
        self.assertEqual(sandbox.process.wait.call_count, 2)
        self.assertEqual(sandbox.process.wait.call_args_list[0].kwargs["max_wait"], 1000)
        self.assertEqual(sandbox.process.wait.call_args_list[1].kwargs["max_wait"], 30_000)
        self.assertTrue(result.timed_out)
        self.assertEqual(result.code, -1)

    def test_validation_cache_is_bound_to_workspace_image_and_region(self):
        with tempfile.TemporaryDirectory() as d:
            task = SimpleNamespace(path=Path(d))
            (task.path / "validation").mkdir()
            settings = runner.Settings(workspace="eval-only", image="sandbox/image:one")
            record = {"status": "valid", **runner.environment_identity(settings)}
            (task.path / "validation/result.json").write_text(json.dumps(record))
            self.assertEqual(runner.validation_status(task, settings), "valid")
            settings.image = "sandbox/image:two"
            self.assertIsNone(runner.validation_status(task, settings))


class TrialBoundaryTests(unittest.TestCase):
    def trial(self, d, events, prepare, on_delete=lambda name: None):
        """run_trial with every sandbox step mocked; the agent's sandbox is "agent", the verifier "verifier"."""
        task = SimpleNamespace(id="public-task", instruction="Fix the public example.",
                               meta={"task": {"repo": "public/example"}, "agent": {}, "environment": {}}, path=d)
        model = SimpleNamespace(key="model", model="model", provider="anthropic")

        def agent(name, model, secrets, path, timeout):
            path.write_text("")
            events.append(("agent", name))
            return {"subtype": "success", "timed_out": False}

        def tests(name, *_):
            events.append(("hidden", name))
            return {"passed": True, "timed_out": False, "output": "ok"}
        with mock.patch.object(runner, "container_name", side_effect=["agent", "verifier"]), \
                mock.patch.object(runner, "credential_env", return_value={}), \
                mock.patch.object(runner, "start_container", side_effect=lambda name, *_: events.append(("create", name))), \
                mock.patch.object(runner, "prepare_workspace", side_effect=prepare), \
                mock.patch.object(runner, "block_lookups"), \
                mock.patch.object(runtime, "upload", side_effect=lambda name, *_: events.append(("upload", name))), \
                mock.patch.object(runtime, "download"), \
                mock.patch.object(runtime, "delete", side_effect=lambda name: (events.append(("delete", name)), on_delete(name))), \
                mock.patch.object(runner, "run_agent", side_effect=agent), \
                mock.patch.object(runner, "price_agent", side_effect=lambda agent, *args: agent), \
                mock.patch.object(runner, "capture_patch", return_value=("patch", "1\t0\tfile.py")), \
                mock.patch.object(runner, "sh", return_value=(0, "", False)), \
                mock.patch.object(runner, "set_aside_agent_tests", return_value=[]), \
                mock.patch.object(runner, "run_tests", side_effect=tests):
            return runner.run_trial(task, model, 1, d / "trial", "run-one", runner.Settings(workspace="eval-only"))

    def test_the_answer_reaches_the_verifier_only_after_the_agent_vm_is_deleted(self):
        events, both_set_up = [], threading.Barrier(2, timeout=5)

        def prepare(name, *_):
            events.append(("prepare", name))
            both_set_up.wait()  # the verifier is set up while the agent's sandbox is
            return None, {"baseline": "a" * 40}
        with tempfile.TemporaryDirectory() as d:
            result = self.trial(Path(d), events, prepare)
        gone = events.index(("delete", "agent"))
        self.assertLess(events.index(("prepare", "verifier")), events.index(("agent", "agent")))
        self.assertEqual(events[gone + 1:], [("upload", "verifier"), ("hidden", "verifier"), ("delete", "verifier")])
        self.assertEqual(result["outcome"], "solved")

    def test_an_attempt_that_ends_early_deletes_the_verifier_mid_setup(self):
        events, deleted, finished = [], threading.Event(), threading.Event()

        def prepare(name, *_):
            if name == "agent":
                return "setup-error", {}
            deleted.wait(5)  # a long setup, cut short by the deletion
            events.append(("setup ended", name))
            finished.set()
            return None, {"baseline": "a" * 40}
        with tempfile.TemporaryDirectory() as d:
            result = self.trial(Path(d), events, prepare, on_delete=lambda name: deleted.set())
            finished.wait(5)
        self.assertEqual(result["invalid_reason"], "setup-error")
        self.assertLess(events.index(("delete", "verifier")), events.index(("setup ended", "verifier")))
        self.assertNotIn(("upload", "verifier"), events)


if __name__ == "__main__":
    unittest.main()
