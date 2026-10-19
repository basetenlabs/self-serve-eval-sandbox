"""pr-eval unit tests: no Docker, no network, no keys."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval_sandbox import app, config, pipeline, report, runner, tasks  # noqa: E402
from eval_sandbox.config import Judge, Model  # noqa: E402


def baseten_model() -> Model:
    return Model(key="glm-5.3", label="GLM-5.3", kind="open", provider="baseten", model="zai-org/GLM-5.3",
                 effort="high", prices={"zai-org/GLM-5.3": {"input": 1.40, "cached_input": 0.14, "output": 4.40}})


def anthropic_model() -> Model:
    return Model(key="claude-opus", label="Claude Opus 5.5", kind="closed", provider="anthropic",
                 model="claude-opus-5-5", effort="high",
                 prices={"claude-opus-5-5": {"input": 4.0, "cache_write": 5.0, "cache_write_1h": 8.0,
                                             "cached_input": 0.2, "output": 20.0},
                         "claude-haiku-4-5": {"input": 1.0, "cached_input": 0.1, "output": 5.0}})


class ConfigTest(unittest.TestCase):
    def test_catalog_parses_dotted_keys(self):
        models, judge = config.load()
        self.assertIn("glm-5.3", models)  # a bare TOML key would have split at the dot
        self.assertEqual(models["glm-5.3"].model, "zai-org/GLM-5.3")
        self.assertEqual(models["claude-opus"].kind, "closed")
        for model in models.values():
            self.assertIn(model.model, model.prices, f"{model.key} has no price for its own id")
        self.assertTrue(judge.api_key_env)

    def test_price_from_table(self):
        usage = {"zai-org/GLM-5.3": {"inputTokens": 1_000_000, "cacheReadInputTokens": 1_000_000, "outputTokens": 100_000}}
        self.assertAlmostEqual(baseten_model().price(usage), 1.40 + 0.14 + 0.44)

    def test_dated_model_ids_match_their_prefix(self):
        usage = {"claude-haiku-4-5-20251001": {"inputTokens": 1_000_000, "outputTokens": 0}}
        self.assertAlmostEqual(anthropic_model().price(usage), 1.0)

    def test_one_hour_cache_writes_cost_more(self):
        usage = {"claude-opus-5-5": {"cacheCreationInputTokens": 2_000_000, "cacheCreation1hInputTokens": 1_000_000}}
        self.assertAlmostEqual(anthropic_model().price(usage), 5.0 + 8.0)

    def test_unknown_model_is_unpriced_not_free(self):
        self.assertIsNone(baseten_model().price({"someone/else": {"inputTokens": 10, "outputTokens": 10}}))

    def test_a_run_keeps_the_models_it_recorded(self):
        model = baseten_model()
        model.max_concurrent = 2
        self.assertEqual(Model.from_dict(json.loads(json.dumps(model.as_dict()))), model)

    def test_a_misspelled_setting_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "models.toml"
            path.write_text('[models.m]\nkind = "open"\nprovider = "baseten"\nmodel = "m"\nmax_concurent = 2\n'
                            '[judge]\nmodel = "j"\nbase_url = "http://x"\napi_key_env = "K"\n')
            with self.assertRaises(SystemExit) as caught:
                config.load(path)
        self.assertIn("max_concurent", str(caught.exception))


class CostTest(unittest.TestCase):
    def test_anthropic_uses_claude_codes_list_price(self):
        usage = {"claude-opus-5-5": {"inputTokens": 20, "outputTokens": 3839, "cacheReadInputTokens": 204617,
                                     "cacheCreationInputTokens": 27462, "costUSD": 0.3374794, "costBasis": "list"}}
        cost, source = runner.agent_cost(anthropic_model(), usage)
        self.assertAlmostEqual(cost, 0.3374794)
        self.assertEqual(source, "claude-code-list-price")

    def test_open_model_ignores_claude_codes_figure(self):
        usage = {"zai-org/GLM-5.3": {"inputTokens": 79205, "outputTokens": 11520, "cacheReadInputTokens": 1225600,
                                     "costUSD": 1.296825, "costBasis": "unknown"}}
        cost, source = runner.agent_cost(baseten_model(), usage)
        self.assertEqual(source, "price-table")
        self.assertAlmostEqual(cost, (79205 * 1.40 + 1225600 * 0.14 + 11520 * 4.40) / 1e6)


class AgentScriptTest(unittest.TestCase):
    def test_baseten_goes_through_the_proxy_with_web_tools_off(self):
        script, env = runner.agent_script(baseten_model())
        self.assertIn("proxy.py", script)
        self.assertIn("--disallowedTools WebFetch,WebSearch", script)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], f"http://127.0.0.1:{runner.PROXY_PORT}")
        self.assertEqual(env["ANTHROPIC_SMALL_FAST_MODEL"], "zai-org/GLM-5.3")
        self.assertNotIn("BASETEN_API_KEY=", script)  # the key arrives by name through docker exec -e

    def test_anthropic_talks_to_anthropic(self):
        script, env = runner.agent_script(anthropic_model())
        self.assertNotIn("proxy.py", script)
        self.assertNotIn("ANTHROPIC_BASE_URL", env)
        self.assertIn("--model claude-opus-5-5", script)

    def test_stream_keeps_final_usage(self):
        self.assertIn("--include-partial-messages", runner.agent_script(anthropic_model())[0])

    def test_lookups_of_the_answer_are_blocked(self):
        for host in ("github.com", "api.github.com", "raw.githubusercontent.com", "pypi.org", "registry.npmjs.org"):
            self.assertIn(host, runner.BLOCKED_HOSTS)


class ParsingTest(unittest.TestCase):
    def test_diff_stats(self):
        self.assertEqual(runner.diff_stats("3\t1\tsrc/a.py\n-\t-\tlogo.png\n10\t0\ttests/t.py\n"),
                         {"files": 3, "added": 13, "removed": 1})

    def test_test_summary_lines(self):
        self.assertIn("2 failed", runner.test_summary("x\n== 2 failed, 10 passed in 1.2s ==\n"))
        self.assertEqual(runner.test_summary("ok  \tgithub.com/x/y\t0.1s\nok  \tgithub.com/x/z\t0.1s\n"), "2 packages ok")
        self.assertTrue(runner.test_summary("ok  \tx/y\t0.1s\nFAIL\tx/z\t0.2s\n").startswith("1 of 2 packages failed"))
        # vitest prints its summary above the failure details, in color
        vitest = "\x1b[31m Test Files  1 failed (1)\n      Tests  2 failed | 9 passed (11)\n" + "detail\n" * 80
        self.assertEqual(runner.test_summary(vitest), "Tests  2 failed | 9 passed (11)")

    def test_stream_summary(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "agent.jsonl"
            path.write_text("\n".join(json.dumps(e) for e in [
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}},
                {"type": "result", "subtype": "success", "is_error": False, "num_turns": 2, "result": "done",
                 "modelUsage": {"m": {"inputTokens": 1, "outputTokens": 2}}},
            ]) + "\nnot json\n")
            summary = runner.summarize_stream(path)
        self.assertEqual(summary["tool_calls"], {"Bash": 1})
        self.assertEqual(summary["num_turns"], 2)
        self.assertEqual(runner.token_totals(summary["model_usage"])["output"], 2)


def assistant(message_id, model="claude-opus-5-5", output=1, **usage):
    return {"type": "assistant", "parent_tool_use_id": None,
            "message": {"id": message_id, "model": model, "content": [{"type": "text", "text": "x"}],
                        "usage": {"input_tokens": 10, "cache_read_input_tokens": 1000,
                                  "cache_creation_input_tokens": 100, "output_tokens": output,
                                  "cache_creation": {"ephemeral_1h_input_tokens": 100}, **usage}}}


def stream_event(kind, **fields):
    return {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": kind, **fields}}


class StoppedRunTest(unittest.TestCase):
    """An attempt stopped at the time limit has no `result` event; its cost comes from the log."""

    def write(self, d, events):
        path = Path(d) / "agent.jsonl"
        path.write_text("\n".join(json.dumps(e, separators=(",", ":")) for e in events) + "\n")
        return path

    def test_output_comes_from_message_deltas(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [
                stream_event("message_start", message={"id": "m1"}), assistant("m1"), assistant("m1"),
                stream_event("message_delta", usage={"output_tokens": 500}),
                stream_event("message_start", message={"id": "m2"}), assistant("m2"),  # cut off here
                assistant("s", model="<synthetic>"),
            ])
            usage, complete = runner.rebuild_usage(path, anthropic_model())
        self.assertTrue(complete)
        self.assertEqual(list(usage), ["claude-opus-5-5"])
        counts = usage["claude-opus-5-5"]
        self.assertEqual((counts["inputTokens"], counts["cacheReadInputTokens"], counts["outputTokens"]), (20, 2000, 501))
        self.assertEqual(counts["cacheCreation1hInputTokens"], 200)

    def test_without_deltas_output_is_partial(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [assistant("m1"), assistant("m2")])
            agent = runner.price_agent({"timed_out": True}, anthropic_model(), path)
        self.assertEqual(agent["cost_source"], "rebuilt-partial")
        self.assertEqual(agent["tokens"]["input"], 20)
        self.assertGreater(agent["cost_usd"], 0)

    def test_proxy_log_gives_open_model_output(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [assistant("m1", model="zai-org/GLM-5.3", cache_creation_input_tokens=0,
                                            cache_creation={})])
            proxy = Path(d) / "proxy.log"
            proxy.write_text("proxy listening\nturn=1 /v1/messages -> 200 in=1010 out=700\n"
                             "turn=2 /v1/messages -> 429 in=None out=None\n")
            agent = runner.price_agent({"timed_out": True}, baseten_model(), path, proxy)
        self.assertEqual(agent["cost_source"], "rebuilt")
        self.assertEqual(agent["tokens"]["output"], 700)
        self.assertAlmostEqual(agent["cost_usd"], (10 * 1.40 + 1000 * 0.14 + 700 * 4.40) / 1e6)

    def test_finished_run_keeps_claude_codes_figures(self):
        usage = {"zai-org/GLM-5.3": {"inputTokens": 1_000_000, "outputTokens": 0}}
        agent = runner.price_agent({"model_usage": usage}, baseten_model(), Path("/nonexistent"))
        self.assertEqual((agent["cost_source"], agent["cost_usd"]), ("price-table", 1.40))

    def test_compaction_drops_token_deltas_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [stream_event("message_start", message={"id": "m1"}),
                                  *[stream_event("content_block_delta", delta={"text": "x"})] * 50,
                                  assistant("m1"), stream_event("message_delta", usage={"output_tokens": 9})])
            runner.compact_stream(path)
            kinds = [(e["type"], (e.get("event") or {}).get("type")) for e in map(json.loads, path.read_text().splitlines())]
        self.assertEqual(kinds, [("stream_event", "message_start"), ("assistant", None),
                                 ("stream_event", "message_delta")])


class RecipeTest(unittest.TestCase):
    def test_recipes_cover_the_sample_languages(self):
        self.assertIn("go test", tasks.recipe("go-chi/chi", "Go", [])["test"])
        self.assertIn("pytest", tasks.recipe("someone/any-python-repo", "Python", [])["test"])
        hono = tasks.recipe("honojs/hono", "TypeScript", ["src/a.test.ts", "README.md"], {"packageManager": "pnpm@9.1.0"})
        self.assertIn("src/a.test.ts", hono["test"])
        self.assertNotIn("README.md", hono["test"])
        self.assertTrue(hono["setup"].startswith("corepack pnpm@9.1.0 install"))
        with self.assertRaises(tasks.Skip):
            tasks.recipe("someone/rust", "Rust", [])

    def test_sample_list_parses(self):
        sample = tasks.sample()
        self.assertEqual(sum(map(len, sample.values())), 42)
        self.assertIn(1159, sample["go-chi/chi"])

    def test_spread_mixes_repositories(self):
        rows = [{"repo": "a", "n": i} for i in range(5)] + [{"repo": "b", "n": i} for i in range(5)]
        picked = tasks.spread(rows, 4)
        self.assertEqual(sorted(r["repo"] for r in picked), ["a", "a", "b", "b"])


class CollectTest(unittest.TestCase):
    """A merged PR in a throwaway repository, exported the way `pr-eval collect` does it."""

    def setUp(self):
        import subprocess
        self.dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.dir.name) / "repo"
        self.repo.mkdir()

        def git(*args):
            return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=self.repo,
                                  check=True, capture_output=True, text=True).stdout.strip()
        self.git = git
        (self.repo / "tests").mkdir()
        (self.repo / "lib.py").write_text("def double(x):\n    return x\n")
        (self.repo / "tests" / "test_lib.py").write_text("old test\n")
        (self.repo / "tests" / "test_gone.py").write_text("removed by the PR\n")
        git("init", "-q", "-b", "main")
        git("add", "-A")
        git("commit", "-qm", "base")
        self.base = git("rev-parse", "HEAD")
        git("checkout", "-qb", "fix")
        (self.repo / "lib.py").write_text("def double(x):\n    return 2 * x\n")
        (self.repo / "tests" / "test_lib.py").write_text("hidden test: double(2) == 4\n")
        git("rm", "-q", "tests/test_gone.py")
        git("commit", "-qam", "fix")
        git("checkout", "-q", "main")
        git("merge", "-q", "--no-ff", "fix", "-m", "merge")
        self.pr = {"number": 7, "title": "Fix double", "body": "Fixes #3", "merge_commit_sha": git("rev-parse", "HEAD"),
                   "html_url": "https://github.com/o/r/pull/7", "merged_at": "2026-10-01T00:00:00Z"}
        self.out = Path(self.dir.name) / "tasks"
        self.out.mkdir()

    def tearDown(self):
        self.dir.cleanup()

    def export(self, **kwargs):
        from unittest import mock
        issue = {"title": "double() returns its input", "body": "double(2) should be 4, but it returns 2. " * 3}
        with mock.patch.object(tasks, "gh", return_value=issue):
            return tasks.export_task(self.repo / ".git", "o/r", "Python", self.pr, self.out, **kwargs)

    def test_the_answer_stays_out_of_the_agents_copy(self):
        import tarfile
        task = tasks.load(self.export())
        with tarfile.open(task.path / "environment" / "source.tar") as tar:
            source = {m.name: tar.extractfile(m).read().decode() for m in tar.getmembers() if m.isfile()}
        self.assertEqual(source["lib.py"], "def double(x):\n    return x\n")
        self.assertEqual(source["tests/test_lib.py"], "old test\n")
        self.assertEqual((task.path / "tests/files/tests/test_lib.py").read_text(), "hidden test: double(2) == 4\n")
        self.assertEqual((task.path / "tests/deleted.txt").read_text(), "tests/test_gone.py\n")
        self.assertIn("+    return 2 * x", (task.path / "solution/reference.patch").read_text())
        self.assertEqual(task.meta["task"]["base_sha"], self.base)
        self.assertEqual(task.meta["task"]["instruction_source"], "linked-issue")
        self.assertTrue(task.instruction.startswith("# Fix double\n\ndouble() returns its input\n\n"))

    def test_own_commands_and_changed_test_files(self):
        task = tasks.load(self.export(setup="make deps", test="pytest {test_files}"))
        self.assertEqual(task.meta["environment"]["setup"], "make deps")
        self.assertEqual(task.meta["verifier"]["test"], "pytest tests/test_gone.py tests/test_lib.py")

    def test_a_pr_that_only_changes_tests_is_skipped(self):
        (self.repo / "tests" / "test_lib.py").write_text("another test\n")
        self.git("commit", "-qam", "tests only, squash-merged")
        self.pr["merge_commit_sha"] = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(tasks.Skip, "both code and tests"):
            self.export()


class PatchCaptureTest(unittest.TestCase):
    def test_work_the_agent_committed_still_counts(self):
        import subprocess
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            def local_sh(container, script, *, timeout, **_):  # the container's /workspace, here
                p = subprocess.run(["bash", "-c", script], cwd=d, capture_output=True, text=True)
                return p.returncode, p.stdout + p.stderr, False
            git = "git -c user.name=t -c user.email=t@t"
            local_sh(None, f"git init -q -b main && echo old > a.txt && git add -A && {git} commit -qm setup", timeout=9)
            baseline = local_sh(None, "git rev-parse HEAD", timeout=9)[1].strip()
            # What Muse Spark did: a branch of its own, the fix committed, plus one uncommitted file
            local_sh(None, f"git checkout -qb fix && echo new > a.txt && {git} commit -qam fix && echo b > b.txt", timeout=9)
            with mock.patch.object(runner, "sh", local_sh):
                patch, numstat = runner.capture_patch("unused", baseline)
        self.assertIn("+new", patch)
        self.assertIn("b.txt", patch)
        self.assertEqual(runner.diff_stats(numstat)["files"], 2)


class PipelineTest(unittest.TestCase):
    def test_resume_adds_new_models_after_the_runs_own(self):
        meta = {"models": [{"key": "claude-opus"}, {"key": "glm-5.3"}]}
        self.assertEqual(pipeline.resumed_models(meta, None), (["claude-opus", "glm-5.3"], []))
        self.assertEqual(pipeline.resumed_models(meta, ["glm-5.3", "muse-spark"]),
                         (["claude-opus", "glm-5.3", "muse-spark"], ["muse-spark"]))

    def job(self, d, request):
        return pipeline.new_job(request, [baseten_model()], None, name="r1", jobs_dir=Path(d) / "jobs",
                                tasks_dir=Path(d) / "tasks")

    def test_a_run_says_why_it_failed(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "tasks").mkdir()
            job = self.job(d, pipeline.Request(task_ids=["missing-task"]))
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
                pipeline.execute(job, [baseten_model()], runner.Settings())
            status = pipeline.Job(job.path).meta["status"]
        self.assertEqual(status["phase"], "failed")
        self.assertIn("missing-task", status["detail"])

    def test_a_stopped_run_can_be_resumed(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            job = self.job(d, pipeline.Request(repos=["o/r"]))
            with mock.patch.object(pipeline, "find_tasks", side_effect=KeyboardInterrupt), \
                    mock.patch.object(runner, "cleanup") as cleanup, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pipeline.execute(job, [baseten_model()], runner.Settings()), 130)
            meta = pipeline.Job(job.path).meta
        cleanup.assert_called_once_with("r1")  # containers of the stopped run are removed
        self.assertEqual(meta["status"]["phase"], "stopped")
        self.assertEqual(meta["request"]["repos"], ["o/r"])  # what resume needs to start over
        self.assertEqual(meta["tasks"], [])

    def test_a_run_name_is_the_repository_and_the_time(self):
        self.assertTrue(pipeline.default_name(pipeline.Request(repos=["o/my-repo"])).startswith("my-repo-"))
        self.assertTrue(pipeline.default_name(pipeline.Request()).startswith("sample-"))


class AppTest(unittest.TestCase):
    def test_repositories_in_the_forms_people_paste(self):
        for text in ("o/r", " o/r ", "https://github.com/o/r", "github.com/o/r/pull/12", "git@github.com:o/r.git",
                     "https://github.com/o/r.git"):
            self.assertEqual(app.parse_repo(text), "o/r", text)
        for text in ("", "o", "o/r/x y", "https://gitlab.com/o/r; rm -rf /"):
            self.assertIsNone(app.parse_repo(text), text)

    def test_runs_show_their_phase_progress_and_results(self):
        with tempfile.TemporaryDirectory() as d:
            jobs = Path(d)
            old = jobs / "old"  # a run from before status was recorded, and finished
            (old / "trials" / "t-1__m__1").mkdir(parents=True)
            (old / "trials" / "t-1__m__1" / "result.json").write_text("{}")
            (old / "run.json").write_text(json.dumps({"run_id": "old", "tasks": ["o__r-1"], "attempts": 1,
                                                      "models": [{"key": "m", "label": "M"}]}))
            dead = jobs / "dead"  # says it is running, but its process is gone
            dead.mkdir()
            (dead / "run.json").write_text(json.dumps({"run_id": "dead", "request": {"repos": ["o/r"]}, "tasks": [],
                                                       "models": [], "status": {"phase": "running", "pid": 999999}}))
            (dead / "log.txt").write_text("cloning o/r\nTraceback: boom\n")
            page = app.App(jobs)
            old_run, dead_run = page.describe(old), page.describe(dead)
        self.assertEqual((old_run["phase"], old_run["title"], old_run["progress"]), ("done", "o/r", {"done": 1, "total": 1}))
        self.assertEqual(dead_run["phase"], "stopped")
        self.assertTrue(dead_run["resumable"])
        self.assertIn("boom", dead_run["log"])

    def test_only_this_page_can_start_runs(self):
        import http.client
        import threading
        with tempfile.TemporaryDirectory() as d:
            handler = type("H", (app.Handler,), {"app": app.App(Path(d))})
            server = app.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            port = server.server_address[1]

            def post(headers):
                conn = http.client.HTTPConnection("127.0.0.1", port)
                conn.request("POST", "/api/runs/x/stop", body="{}", headers=headers)
                return conn.getresponse().status
            try:
                self.assertEqual(post({"content-type": "text/plain"}), 403)  # a form on another site
                self.assertEqual(post({"content-type": "application/json", "origin": "https://evil.example"}), 403)
                self.assertEqual(post({"content-type": "application/json", "host": "evil.example"}), 403)
                self.assertEqual(post({"content-type": "application/json", "origin": f"http://127.0.0.1:{port}"}), 400)
            finally:
                server.shutdown()
                server.server_close()


class ReportTest(unittest.TestCase):
    def trial(self, task, model, outcome, cost):
        return {"trial": f"{task}__{model}__1", "task_id": task, "model": model, "attempt": 1, "outcome": outcome,
                "agent": {"cost_usd": cost, "seconds": 60, "num_turns": 5, "tokens": {"input": 10, "output": 5}},
                "tests": {"passed": outcome == "solved"}, "judge": {"verdict": "pass"}}

    def test_summary_definitions(self):
        trials = [self.trial("t1", "m", "solved", 1.0), self.trial("t2", "m", "failed", 1.0),
                  self.trial("t3", "m", "invalid", 5.0)]
        s = report.summarize(trials)
        self.assertEqual((s["valid"], s["invalid"], s["solved"]), (2, 1, 1))
        self.assertEqual(s["pass_at_1"], 0.5)
        self.assertEqual(s["cost_per_solved"], 2.0)  # the failure is paid for; the invalid one is not counted

    def test_rate_limit_waits_are_not_working_time(self):
        with tempfile.TemporaryDirectory() as d:
            trial_dir = Path(d) / "x__glm-5.3__1"
            trial_dir.mkdir()
            trial = self.trial("x", "glm-5.3", "solved", 0.5)
            trial["agent"].update(seconds=100, retry_wait_seconds=30)
            (trial_dir / "result.json").write_text(json.dumps(trial))
            record = report.trial_record(trial_dir)
        self.assertEqual(record["agent"]["working_seconds"], 70)
        self.assertEqual(report.summarize([record])["median_seconds"], 70)

    def test_report_builds_from_a_job_directory(self):
        with tempfile.TemporaryDirectory() as d:
            job = Path(d) / "jobs" / "r1"
            for model, outcome in (("claude-opus", "solved"), ("glm-5.3", "failed")):
                trial_dir = job / "trials" / f"x__{model}__1"
                trial_dir.mkdir(parents=True)
                (trial_dir / "result.json").write_text(json.dumps(self.trial("x", model, outcome, 0.5)))
                (trial_dir / "agent.patch").write_text("diff --git a/x b/x\n+</script><b>")
            (job / "run.json").write_text(json.dumps({
                "run_id": "r1", "created_at": "2026-10-16T00:00:00+00:00", "attempts": 1, "tasks": ["x"],
                "tasks_dir": str(Path(d) / "tasks"), "image": "img", "harness_version": "2.1.296", "judge": None,
                "models": [anthropic_model().as_dict(), baseten_model().as_dict()]}))
            html = report.build(job).read_text()
            data = json.loads((job / "report.json").read_text())
            self.assertTrue(data["complete"])
            self.assertEqual(data["summary"]["claude-opus"]["solved"], 1)
            self.assertNotIn("+</script><b>", html)  # an agent's diff can't end the data block


class JudgeTest(unittest.TestCase):
    task = tasks.Task(id="x", path=Path("/nonexistent"), meta={"task": {"repo": "a/b"}}, instruction="do it")
    judge = Judge(model="m", base_url="http://localhost:9", api_key_env="PR_EVAL_TEST_UNSET")

    def test_missing_key_is_an_error_not_a_verdict(self):
        from eval_sandbox import judge
        self.assertIn("error", judge.grade(self.judge, self.task, "diff", {"passed": True}, ""))

    def test_solved_needs_the_tests_and_the_judge(self):
        from unittest import mock
        cases = [(True, {"verdict": "pass"}, ("solved", None)), (True, {"verdict": "fail"}, ("failed", None)),
                 (False, {"verdict": "pass"}, ("failed", None)), (True, {"error": "HTTP 500"}, ("invalid", "judge-error"))]
        for passed, verdict, expected in cases:
            with tempfile.TemporaryDirectory() as d, mock.patch.object(runner.judge_mod, "grade", return_value=dict(verdict)):
                _, outcome, reason = runner.judge_attempt(self.judge, self.task, "diff", {"passed": passed}, "", Path(d))
                self.assertTrue((Path(d) / "judge.json").is_file())
            self.assertEqual((outcome, reason), expected, (passed, verdict))


if __name__ == "__main__":
    unittest.main()
