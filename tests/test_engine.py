"""Attempts that fail say why and keep their log, passing failures are tried once more, a run whose attempts
all fail alike stops early, and memory stays bounded. Offline: every sandbox step is faked."""
from __future__ import annotations

import contextlib
import errno
import io
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import app, baseten, causes, config, judge, pipeline, report, runner, runtime

MODEL = SimpleNamespace(key="model", model="model", provider="anthropic", max_concurrent=None,
                        prices={"model": {"input": 1, "output": 1}})


def task(d: Path, task_id: str = "public-task"):
    return SimpleNamespace(id=task_id, instruction="Fix the public example.", path=d,
                           meta={"task": {"repo": "public/example"}, "agent": {}, "environment": {}, "verifier": {}})


def no_such_device() -> runtime.RuntimeError:
    """What the hosted page's upload raised on 2026-11-10, chained as runtime.upload chains it."""
    try:
        try:
            raise OSError(errno.ENODEV, "No such device")
        except OSError as exc:
            raise runtime.RuntimeError("Could not upload source.tar.gz (OSError).") from exc
    except runtime.RuntimeError as exc:
        return exc


def creation_timed_out() -> runtime.RuntimeError:
    try:
        try:
            raise TimeoutError("timed out")
        except TimeoutError as exc:
            raise runtime.RuntimeError("Baseten creation failed for pr-eval-x-1234 (TimeoutError); use cleanup.") from exc
    except runtime.RuntimeError as exc:
        return exc


@contextlib.contextmanager
def sandboxes(prepare=None, create=None):
    """run_trial's sandbox steps, faked: `prepare(name, ...)` stands in for prepare_workspace,
    `create(name)` for creating a sandbox."""
    names = iter(f"sandbox-{n}" for n in range(1000))

    def tests(name, *_):
        return {"passed": True, "timed_out": False, "output": "1 passed in 0.1s", "summary": "1 passed"}

    def agent(name, model, placeholder_env, relay_headers, path, *_):
        path.write_text("")
        return {"subtype": "success", "timed_out": False}
    with mock.patch.object(runner, "container_name", side_effect=lambda run_id: next(names)), \
            mock.patch.object(runner, "credential_env", return_value={"ANTHROPIC_API_KEY": "real"}), \
            mock.patch.object(runtime, "create", side_effect=create or (lambda *a, **k: None)), \
            mock.patch.object(runner, "prepare_workspace",
                              side_effect=prepare or (lambda *a: (None, {"baseline": "a" * 40}))), \
            mock.patch.object(runtime, "upload"), mock.patch.object(runtime, "download"), \
            mock.patch.object(runtime, "delete"), \
            mock.patch.object(runner, "run_agent", side_effect=agent), \
            mock.patch.object(runner, "price_agent", side_effect=lambda a, *_: a), \
            mock.patch.object(runner, "capture_patch", return_value=("patch", "1\t0\tfile.py")), \
            mock.patch.object(runner, "sh", return_value=(0, "", False)), \
            mock.patch.object(runner, "set_aside_agent_tests", return_value=[]), \
            mock.patch.object(runner, "run_tests", side_effect=tests), \
            mock.patch.object(runner.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
        yield


def run_one(d: Path, the_task=None) -> dict:
    trial = runner.trial_runner([MODEL], runner.Settings(), "run-one")
    the_task = the_task or task(d)
    return trial((the_task, MODEL, 1, d / "trials" / runner.trial_name(the_task, MODEL, 1)))


class CauseTests(unittest.TestCase):
    def test_todays_upload_failure_says_its_step_and_cause_and_keeps_its_log_everywhere(self):
        def prepare(name, *_):
            raise runner.StepFailed("upload", "the agent's", no_such_device())
        with tempfile.TemporaryDirectory() as d, sandboxes(prepare=prepare):
            d = Path(d)
            result = run_one(d)
            trial_dir = d / "trials" / result["trial"]
            saved = json.loads((trial_dir / "result.json").read_text())
            record = report.trial_record(trial_dir)
        self.assertEqual((saved["outcome"], saved["invalid_reason"], saved["step"]), ("invalid", "sandbox-error", "upload"))
        self.assertEqual(saved["cause"], "Could not upload the task's files to the agent's sandbox "
                                         "(this machine could not read or write a file: no such device).")
        self.assertFalse(saved["transient"])  # the same error on every try: not tried again
        self.assertNotIn("first_try", saved)
        self.assertEqual(saved["log"], "error.log")
        # The cell and the live activity: a few words; the sheet and the report: the sentence and the log.
        cell = app.cell("model", 1, saved)
        self.assertEqual(cell["reason"], "Source upload failed")
        self.assertLessEqual(len(cell["reason"]), 40)
        self.assertEqual(record["cause"], saved["cause"])
        self.assertIn("OSError: [Errno 19] No such device", record["log"])
        self.assertIn("Could not upload source.tar.gz", record["log"])
        for text in (saved["cause"], cell["reason"]):
            self.assertNotIn("sandbox-error", text)
            self.assertNotIn("OSError", text)

    def test_every_reason_has_a_short_cell_and_a_sentence(self):
        reasons = [*causes.REASONS, "verifier-setup-error", "verifier-setup-timeout", "verifier-workspace-error",
                   "runner-error: boom", "something-new"]
        for reason in reasons:
            with self.subTest(reason=reason):
                result = {"outcome": "invalid", "invalid_reason": reason}
                self.assertTrue(causes.short(result))
                self.assertLessEqual(len(causes.short(result)), 40)
                self.assertTrue(causes.sentence(result).endswith("."))
                self.assertNotIn("-error", causes.short(result) + causes.sentence(result))
        verifier = {"outcome": "invalid", "invalid_reason": "verifier-setup-error"}
        self.assertEqual(causes.short(verifier), "Verifier: dependency install failed")
        self.assertIsNone(causes.short({"outcome": "solved"}))

    def test_a_failed_install_points_at_its_log_in_the_right_sandbox(self):
        def prepare(name, task, log_dir, *_):
            (log_dir / "setup.log").write_text("ERROR: No matching distribution found for nothing==9\n")
            return ("setup-error", {}) if log_dir.name == "verification" else (None, {"baseline": "a" * 40})
        with tempfile.TemporaryDirectory() as d, sandboxes(prepare=prepare):
            result = run_one(Path(d))
            record = report.trial_record(Path(d) / "trials" / result["trial"])
        self.assertEqual((result["invalid_reason"], result["step"], result["log"]),
                         ("verifier-setup-error", "setup", "verification/setup.log"))
        self.assertEqual(app.cell("model", 1, result)["reason"], "Verifier: dependency install failed")
        self.assertIn("No matching distribution", record["log"])

    def test_passing_and_lasting_failures_are_told_apart(self):
        self.assertTrue(causes.transient(creation_timed_out()))
        self.assertTrue(causes.transient(runtime.RuntimeError("Baseten process transport failed (SandboxError).")))
        self.assertTrue(causes.transient(baseten.SandboxError("POST /process failed (502): bad gateway", 502)))
        self.assertTrue(causes.transient(baseten.SandboxError("POST /v1/sandboxes/instances failed (429): Quota exceeded: 10/10 sandboxes", 429)))
        self.assertFalse(causes.transient(runtime.RuntimeError("The sandbox can't keep a step off the network: pr-eval jail: x")))
        self.assertTrue(causes.transient(ConnectionResetError()))
        self.assertFalse(causes.transient(no_such_device()))
        self.assertFalse(causes.transient(runtime.RuntimeError("Trial image must run non-root, refuse in-sandbox API access and jail a command.")))
        self.assertFalse(causes.transient(runtime.RuntimeError("Could not unpack uploaded files.")))


    def test_a_provider_error_says_what_the_provider_said(self):
        cause = causes.provider("API Error: Request rejected (429) · Rate limit exceeded\n")
        self.assertIn("Rate limit exceeded", cause)
        self.assertTrue(cause.startswith("The model's provider"))
        self.assertEqual(causes.provider(""), causes.REASONS["provider-error"][1])


class NameTests(unittest.TestCase):
    def test_a_sandbox_name_stays_under_49_characters_whatever_the_run_is_called(self):
        for run_id in ("quick-20261110-220116", "a-very-long-repository-name-for-sure-20261110-220116-2", "x" * 80, "---"):
            with self.subTest(run_id=run_id):
                name = runner.container_name(run_id)
                self.assertLessEqual(len(name), 49)
                self.assertRegex(name, r"^pr-eval-[a-z0-9-]*[a-z0-9]-[0-9a-f]{8}$|^pr-eval-trial-[0-9a-f]{8}$")

    def test_a_refused_request_is_not_tried_again(self):
        refused = baseten.SandboxError("POST /v1/sandboxes/instances failed (400): no such image", 400)
        try:
            raise runtime.RuntimeError("Baseten creation failed for pr-eval-x (400)") from refused
        except runtime.RuntimeError as exc:
            self.assertFalse(causes.transient(exc))


class RetryTests(unittest.TestCase):
    def test_a_passing_failure_is_tried_once_more_and_says_so(self):
        calls = []

        def create(name, *_args, **_kwargs):
            calls.append(name)
            if len(calls) == 1:
                raise creation_timed_out()
        with tempfile.TemporaryDirectory() as d, sandboxes(create=create):
            result = run_one(Path(d))
            saved = json.loads((Path(d) / "trials" / result["trial"] / "result.json").read_text())
        self.assertEqual(saved["outcome"], "solved")
        self.assertEqual(saved["first_try"]["step"], "boot")
        self.assertIn("Baseten could not start", saved["first_try"]["cause"])

    def test_a_passing_failure_is_tried_only_once_and_a_lasting_one_not_again(self):
        tries = {"boot": 0, "upload": 0}

        def create(name, *_args, **_kwargs):
            tries["boot"] += 1
            raise creation_timed_out()
        with tempfile.TemporaryDirectory() as d, sandboxes(create=create):
            result = run_one(Path(d))
        self.assertEqual((result["outcome"], result["step"], result["transient"]), ("invalid", "boot", True))
        self.assertEqual(tries["boot"], 4)  # each try creates the agent's sandbox and its verifier: two tries, no third

        def prepare(name, *_):
            tries["upload"] += 1
            raise runner.StepFailed("upload", "the agent's", no_such_device())
        with tempfile.TemporaryDirectory() as d, sandboxes(prepare=prepare):
            result = run_one(Path(d))
        self.assertEqual((result["step"], result["transient"]), ("upload", False))
        self.assertLessEqual(tries["upload"], 2)  # the agent's and its verifier's, one try each


class EarlyStopTests(unittest.TestCase):
    def lost(self, task_id: str, cause: str = "Could not upload the task's files to the agent's sandbox.") -> dict:
        return {"trial": f"{task_id}__m__1", "task_id": task_id, "outcome": "invalid",
                "invalid_reason": "sandbox-error", "step": "upload", "cause": cause}

    def test_a_run_whose_attempts_all_fail_alike_stops_and_says_so(self):
        started = []
        jobs = [f"t{n % 8}" for n in range(24)]

        def work(task_id):
            started.append(task_id)
            return self.lost(task_id)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(runner.Halted) as halted:
            runner.in_parallel(jobs, work, 1, "run-one", halt=runner.SameFailure())
        self.assertEqual(len(started), runner.SAME_FAILURES)  # not 24
        self.assertIn("the first 3 attempts all failed the same way (source upload failed)", str(halted.exception))
        self.assertIn("Could not upload the task's files", str(halted.exception))

    def test_different_failures_or_one_that_scored_keep_the_run_going(self):
        def runs(results):
            done = []
            runner.in_parallel(list(range(len(results))), lambda n: (done.append(n), results[n])[1], 1, "run-one",
                               halt=runner.SameFailure())
            return len(done)
        scored = {"task_id": "t9", "outcome": "failed"}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runs([scored] + [self.lost(f"t{n}") for n in range(5)]), 6)
            self.assertEqual(runs([self.lost("t1"), self.lost("t2", "Another cause."), self.lost("t3"), self.lost("t4")]), 4)
            self.assertEqual(runs([self.lost("t1")] * 5), 5)  # one task alone may be that task's trouble

    def test_the_page_shows_a_halted_run_as_failed_with_the_reason(self):
        with tempfile.TemporaryDirectory() as d:
            job = pipeline.new_job(pipeline.Request(task_ids=["t"]), [], None, name="r1", jobs_dir=Path(d))
            job.meta.update(tasks=["t"], checked=True)
            seen = []
            with mock.patch.object(pipeline, "restore_tasks", return_value=[]), \
                    mock.patch.object(pipeline, "prepare_image", return_value="img"), \
                    mock.patch.object(pipeline, "check", return_value=[]), \
                    mock.patch.object(pipeline.report, "build",
                                      side_effect=lambda p: seen.append(pipeline.Job(p).meta["status"]["phase"])), \
                    mock.patch.object(runner, "run", side_effect=runner.Halted("Stopped early: because.")), \
                    mock.patch.dict(os.environ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pipeline.execute(job, [], runner.Settings()), 1)
            status = pipeline.Job(job.path).meta["status"]
        self.assertEqual((status["phase"], status["detail"]), ("failed", "Stopped early: because."))
        self.assertEqual(seen[-1:], ["failed"])  # the report is rebuilt after the status, so it says why


class MemoryTests(unittest.TestCase):
    def test_attempts_at_once_follow_free_memory(self):
        self.assertEqual(runner.fit(20, 8192)[0], 20)  # the hosted page's 8 GB: the whole quick sample at once
        attempts, judges, _ = runner.fit(20, 8192)
        self.assertLessEqual(runner.RESERVE_MB + attempts * runner.ATTEMPT_MB + judges * runner.JUDGE_PROCESS_MB, 8192)
        self.assertEqual(runner.fit(20, 2048)[0], (2048 - runner.RESERVE_MB) // runner.ATTEMPT_MB)
        self.assertEqual(runner.fit(20, 100)[:2], (1, 1))
        with mock.patch.object(runner, "free_memory_mb", return_value=None):
            self.assertEqual(runner.fit(8), (8, 8, None))
        with mock.patch.object(runner, "free_memory_mb", return_value=1024):
            self.assertEqual(runner.fit(20)[0], 3)

    def test_a_run_records_how_many_attempts_go_at_once(self):
        with tempfile.TemporaryDirectory() as d:
            job = pipeline.new_job(pipeline.Request(), [], None, name="r1", jobs_dir=Path(d))
            settings = runner.Settings(concurrency=20)
            with mock.patch.object(runner, "free_memory_mb", return_value=1600), contextlib.redirect_stdout(io.StringIO()):
                pipeline.fit_memory(job, settings)
        self.assertEqual((settings.concurrency, job.meta["concurrency"], job.meta["free_memory_mb"]), (10, 10, 1600))

    def test_claude_code_judges_wait_for_a_place(self):
        at_once, most, lock = [0], [0], threading.Lock()

        def run(*_, **__):
            with lock:
                at_once[0] += 1
                most[0] = max(most[0], at_once[0])
            time.sleep(0.05)
            with lock:
                at_once[0] -= 1
            return SimpleNamespace(stdout=json.dumps({"result": '{"verdict": "pass", "reason": "ok"}'}), stderr="",
                                   returncode=0)
        one = config.Judge(model="claude-opus-5-5", provider="anthropic")
        judge.limit_processes(2)
        try:
            with mock.patch.object(judge.shutil, "which", return_value="/bin/claude"), \
                    mock.patch.object(judge.config, "claude_credential", return_value={"CLAUDE_CODE_OAUTH_TOKEN": "t"}), \
                    mock.patch.object(judge.subprocess, "run", side_effect=run):
                threads = [threading.Thread(target=judge.ask_claude, args=(one, "s", "u")) for _ in range(6)]
                [t.start() for t in threads]
                [t.join(5) for t in threads]
        finally:
            judge.limit_processes(None)
        self.assertEqual(most[0], 2)

    def test_a_command_sends_back_only_the_end_of_its_output(self):
        api = mock.Mock()
        api.runtime.side_effect = lambda box, method, path, **_: {"status": "completed", "exitCode": 0}
        api.read.side_effect = [b"end of output", b""]
        with mock.patch.object(runtime, "client", return_value=api), mock.patch.object(runtime, "get", return_value={}):
            result = runtime.execute("sb", "pip install -v .", timeout=10)
        command = api.runtime.call_args_list[0].kwargs["body"]["command"]
        self.assertIn(f"tail -c {runtime.OUTPUT_LIMIT}", command)
        self.assertTrue(command.endswith("exit $code"))
        read = [c.args[1] for c in api.read.call_args_list]
        self.assertTrue(all(path.endswith(".tail") for path in read))
        self.assertEqual(result.stdout, "end of output")

    def test_the_agents_log_is_never_read_back_whole_with_its_command(self):
        api = mock.Mock()
        api.runtime.side_effect = lambda box, method, path, **_: {"status": "completed", "exitCode": 0}
        api.read.return_value = b""
        with mock.patch.object(runtime, "client", return_value=api), mock.patch.object(runtime, "get", return_value={}):
            result = runtime.execute("sb", "claude", timeout=10, stdout_path="/logs/agent.jsonl",
                                     stderr_path="/logs/agent.stderr")
        self.assertEqual([c.args[1] for c in api.read.call_args_list], ["/logs/agent.stderr.tail"])
        self.assertEqual(result.stdout, "")

    def test_the_tail_shell_keeps_the_end_and_says_how_much_it_left_out(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(runtime, "OUTPUT_LIMIT", 10):
            out = Path(d) / "out"
            out.write_text("x" * 25 + "0123456789")
            script = runtime.tails(str(out)).replace("stat -c %s", "wc -c <")  # GNU stat in the sandbox
            os.system(script)
            self.assertEqual((Path(d) / "out.tail").read_text(), "[25 earlier bytes not kept]\n0123456789")

    def test_redaction_reads_a_piece_at_a_time_and_finds_a_value_split_between_pieces(self):
        secret = "sk-test-0123456789abcdef"
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"TEST_API_KEY": secret}):
            path = Path(d) / "agent.jsonl"
            path.write_text("a" * 7 + secret + "b" * 30 + secret)
            config.redact_file(path, piece=10)
            self.assertEqual(path.read_text(), "a" * 7 + config.MASK + "b" * 30 + config.MASK)

    def test_logs_are_read_from_their_end_and_patches_from_their_start(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "big.log"
            log.write_text("".join(f"line {n}\n" for n in range(200_000)))
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("read whole")):
                self.assertEqual(report.tail(log, 2), "line 199998\nline 199999")
                self.assertTrue(report.read(log, 12).startswith("line 0\nline "))
                self.assertIn("more bytes in big.log", report.read(log, 12))

    def test_a_stream_log_is_compacted_and_summed_a_line_at_a_time(self):
        lines = [{"type": "system", "subtype": "init", "claude_code_version": "2.1.296"},
                 {"type": "stream_event", "event": {"type": "content_block_delta"}},
                 {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "m1"}}},
                 {"type": "assistant", "message": {"id": "m1", "content": [{"type": "tool_use", "name": "Bash"}]}},
                 {"type": "result", "subtype": "success", "num_turns": 1}]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "agent.jsonl"
            path.write_text("".join(json.dumps(line) + "\n" for line in lines))
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("read whole")):
                runner.compact_stream(path)
                summary = runner.summarize_stream(path)
            kept = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(len(kept), 4)  # the per-token delta is gone
        self.assertEqual((summary["claude_code_version"], summary["tool_calls"], summary["subtype"]),
                         ("2.1.296", {"Bash": 1}, "success"))


if __name__ == "__main__":
    unittest.main()
