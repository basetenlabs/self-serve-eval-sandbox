"""pr-eval unit tests: no Docker, no network, no keys."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval_sandbox import app, config, pipeline, report, runner, tasks  # noqa: E402
from eval_sandbox.config import Judge, Model  # noqa: E402


def mock_env(**values):
    from unittest import mock
    return mock.patch.dict("os.environ", values)


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
        self.assertNotIn("BASETEN_API_KEY=", script)  # the key arrives through the process environment

    def test_anthropic_talks_to_anthropic(self):
        script, env = runner.agent_script(anthropic_model())
        self.assertNotIn("proxy.py", script)
        self.assertNotIn("ANTHROPIC_BASE_URL", env)
        self.assertIn("--model claude-opus-5-5", script)

    def test_stream_keeps_final_usage(self):
        self.assertIn("--include-partial-messages", runner.agent_script(anthropic_model())[0])

    def test_lookups_of_the_answer_are_blocked(self):
        from unittest import mock
        with mock.patch.object(runner.runtime, "restrict_network") as restrict:
            runner.block_lookups("trial", ["api.anthropic.com"])
        restrict.assert_called_once_with("trial", ["api.anthropic.com"])


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
        grafana = tasks.recipe("grafana/grafana", "TypeScript", ["pkg/a/x_test.go", "pkg/a/y_test.go", "pkg/b/z_test.go"],
                               imports=["k8s.io/api/core/v1"])
        self.assertEqual(grafana["test"], "go test -count=1 -timeout=600s ./pkg/a ./pkg/b")
        self.assertIn("go list -e -deps -test ./pkg/a ./pkg/b k8s.io/api/core/v1 ", grafana["setup"])
        self.assertEqual(grafana["memory"], 16384)
        with self.assertRaises(tasks.Skip):
            tasks.recipe("grafana/grafana", "TypeScript", ["public/app/a.test.tsx"])
        with self.assertRaises(tasks.Skip):
            tasks.recipe("someone/rust", "Rust", [])

    def test_a_repository_that_needs_a_bigger_sandbox_gets_one(self):
        grafana = SimpleNamespace(meta={"environment": {"memory_mb": 16384}})
        self.assertEqual(runner.sandbox_memory(grafana, runner.Settings(memory=4096)), 16384)
        self.assertEqual(runner.sandbox_memory(grafana, runner.Settings(memory=32768)), 32768)
        self.assertEqual(runner.sandbox_memory(SimpleNamespace(meta={"environment": {}}), runner.Settings()), 4096)

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

    def export(self, commits=(), **kwargs):
        from unittest import mock
        issue = {"title": "double() returns its input", "body": "double(2) should be 4, but it returns 2. " * 3}

        def github(endpoint):
            return [{"commit": {"message": m}} for m in commits] if endpoint.endswith("/commits?per_page=100") else issue
        with mock.patch.object(tasks, "gh", side_effect=github):
            return tasks.export_task(self.repo / ".git", "o/r", "Python", self.pr, self.out, **kwargs)

    def test_go_imports_leave_out_the_standard_library(self):
        (self.repo / "a.go").write_text('package a\n\nimport (\n\t"fmt"\n\tv1 "k8s.io/api/core/v1"\n)\n\n'
                                        'import "github.com/x/y"\n')
        self.git("add", "a.go")
        self.git("commit", "-qm", "go")
        self.assertEqual(tasks.go_imports(self.repo / ".git", "HEAD", ["a.go", "missing.go"]),
                         ["github.com/x/y", "k8s.io/api/core/v1"])

    def test_the_answer_stays_out_of_the_agents_copy(self):
        import tarfile
        task = tasks.load(self.export())
        with tarfile.open(task.path / "environment" / "source.tar.gz") as tar:
            source = {m.name: tar.extractfile(m).read().decode() for m in tar.getmembers() if m.isfile()}
        self.assertEqual(source["lib.py"], "def double(x):\n    return x\n")
        self.assertEqual(source["tests/test_lib.py"], "old test\n")
        self.assertEqual((task.path / "tests/files/tests/test_lib.py").read_text(), "hidden test: double(2) == 4\n")
        self.assertEqual((task.path / "tests/deleted.txt").read_text(), "tests/test_gone.py\n")
        self.assertIn("+    return 2 * x", (task.path / "solution/reference.patch").read_text())
        self.assertEqual(task.meta["task"]["base_sha"], self.base)
        self.assertEqual(task.meta["task"]["instruction_source"], "linked-issue")
        self.assertTrue(task.instruction.startswith("# Fix double\n\ndouble() returns its input\n\n"))
        self.assertNotIn("## Names the tests use", task.instruction)  # the tests call nothing new

    def test_an_older_tasks_plain_snapshot_is_compressed_on_first_use(self):
        import gzip
        task = tasks.load(self.export())
        packed = task.path / "environment" / "source.tar.gz"
        plain = packed.with_suffix("")
        source = gzip.decompress(packed.read_bytes())
        plain.write_bytes(source)
        packed.unlink()
        self.assertEqual(tasks.snapshot(task), packed)
        self.assertFalse(plain.exists())
        self.assertEqual(gzip.decompress(packed.read_bytes()), source)
        self.assertEqual(tasks.snapshot(task), packed)  # and only once

    def test_the_request_gives_the_names_the_tests_call_but_never_the_code(self):
        (self.repo / "lib.py").write_text("def double(x):\n    return x\n\n\ndef label(x) -> str | None:\n    return None\n")
        self.git("commit", "-qam", "more base")
        (self.repo / "lib.py").write_text("def double(x, times=2):\n    return _scale(x, times)\n\n\n"
                                          "def _scale(x, by):\n    return by * x\n\n\n"
                                          "def label(x) -> str:\n    return 'the answer'\n")
        (self.repo / "tests" / "test_lib.py").write_text("assert double(2) == _scale(2, 2) and label(1)\n")
        self.git("commit", "-qam", "fix, squash-merged")
        self.pr["merge_commit_sha"] = self.git("rev-parse", "HEAD")
        names = tasks.load(self.export()).instruction.split("## Names the tests use", 1)[1]
        self.assertIn("- `lib.py`: `def double(x, times=2)`", names)  # its parameters changed
        self.assertIn("- `lib.py`: `def _scale(x, by)`", names)  # new, and the tests call it
        self.assertNotIn("label", names)  # only its return type changed, which is the behavior under test
        self.assertNotIn("return", names)
        self.assertEqual(list(tasks.signatures(['var Host = "https://example.com"', "func (t *T) add(ctx context.Context,",
                                                "\tname string) error {"])),
                         [("Host", "var Host"), ("add", "func (t *T) add(ctx context.Context, name string) error")])

    def test_own_commands_and_changed_test_files(self):
        task = tasks.load(self.export(setup="make deps", test="pytest {test_files}"))
        self.assertEqual(task.meta["environment"]["setup"], "make deps")
        self.assertEqual(task.meta["verifier"]["test"], "pytest tests/test_lib.py")  # not the test it deleted

    def test_a_rebase_merge_starts_before_all_of_the_prs_commits(self):
        self.git("checkout", "-q", "-b", "rebased", self.base)  # the PR's two commits, laid on main one by one
        (self.repo / "lib.py").write_text("def double(x):\n    return x + x\n")
        self.git("commit", "-qam", "first part")
        (self.repo / "tests" / "test_lib.py").write_text("hidden test: double(2) == 4\n")
        self.git("commit", "-qam", "second part")
        self.pr["merge_commit_sha"] = self.git("rev-parse", "HEAD")
        task = tasks.load(self.export(commits=["first part", "second part"]))
        self.assertEqual(task.meta["task"]["base_sha"], self.base)  # not "first part", which holds the fix
        self.assertIn("return x + x", (task.path / "solution/reference.patch").read_text())

    def test_new_commands_make_the_task_again(self):
        from unittest import mock
        self.export()
        github = {"repos/o/r": {"language": "Python"}, "repos/o/r/pulls/7": self.pr}
        with mock.patch.object(tasks, "gh", side_effect=github.get), \
                mock.patch.object(tasks, "clone", return_value=self.repo / ".git"), \
                mock.patch.object(tasks, "export_task") as export:
            tasks.collect("o/r", self.out, prs=[7])
            export.assert_not_called()  # same commands: the folder and its check are kept
            tasks.collect("o/r", self.out, prs=[7], setup="make deps", test="pytest")
            export.assert_called_once()

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
            def local_download(container, remote, local, **_):  # the patch file, byte for byte
                local.write_bytes((Path(d) / remote.removeprefix("/workspace/")).read_bytes())
            with mock.patch.object(runner, "sh", local_sh), \
                    mock.patch.object(runner.runtime, "download", side_effect=local_download):
                patch, numstat = runner.capture_patch("unused", baseline, Path(d) / "agent.patch")
        self.assertIn("+new", patch)
        self.assertIn("b.txt", patch)
        self.assertEqual(runner.diff_stats(numstat)["files"], 2)


    def test_the_agents_own_tests_are_set_aside_before_the_hidden_ones(self):
        import subprocess
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            def local_sh(container, script, *, timeout, **_):
                p = subprocess.run(["bash", "-c", script], cwd=d, capture_output=True, text=True)
                return p.returncode, p.stdout + p.stderr, False
            git = "git -c user.name=t -c user.email=t@t"
            local_sh(None, "git init -q -b main && echo code > lib.go && echo old > lib_test.go && git add -A && "
                           f"{git} commit -qm setup", timeout=9)
            baseline = local_sh(None, "git rev-parse HEAD", timeout=9)[1].strip()
            # the agent fixes the code, edits a test and adds one whose name may clash with the PR's
            local_sh(None, "echo fixed > lib.go && echo mine > lib_test.go && echo TestFix > fix_test.go && git add -A",
                     timeout=9)
            with mock.patch.object(runner, "sh", local_sh):
                set_aside = runner.set_aside_agent_tests("unused", baseline)
            files = {name: (Path(d) / name).read_text().strip() if (Path(d) / name).exists() else None
                     for name in ("lib.go", "lib_test.go", "fix_test.go")}
        self.assertEqual(sorted(set_aside), ["fix_test.go", "lib_test.go"])
        self.assertEqual(files, {"lib.go": "fixed", "lib_test.go": "old", "fix_test.go": None})
        self.assertTrue(runner.touches_tests("diff --git a/lib.go b/lib.go\ndiff --git a/x_test.go b/x_test.go\n"))
        self.assertFalse(runner.touches_tests("diff --git a/lib.go b/lib.go\n"))

class QueueTest(unittest.TestCase):
    def test_a_task_runs_as_soon_as_its_own_check_passes(self):
        from unittest import mock
        events, fast_trial = [], threading.Event()

        def validate(task, *_):
            if task.id == "slow":
                fast_trial.wait(5)  # still checking when the other task's attempt starts
            events.append(("checked", task.id))
            return {"task_id": task.id, "status": "reference-fails" if task.id == "bad" else "valid"}

        def trial(task, *_):
            events.append(("trial", task.id))
            if task.id == "fast":
                fast_trial.set()
            return {"trial": task.id, "outcome": "solved"}
        candidates = [SimpleNamespace(id=i) for i in ("slow", "fast", "bad", "known")]
        seen = []
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(runner, "needs_check", side_effect=lambda t, _: t.id != "known"), \
                mock.patch.object(runner, "validation_status", return_value="valid"), \
                mock.patch.object(runner, "validate_task", side_effect=validate), \
                mock.patch.object(runner, "run_trial", side_effect=trial):
            runner.check_and_run(candidates, [baseten_model()], 1, Path(d), runner.Settings(concurrency=2), "r",
                                 on_checked=lambda t, status, left: seen.append((t.id, status, left)))
        self.assertLess(events.index(("trial", "fast")), events.index(("checked", "slow")))
        self.assertEqual(sorted(t for kind, t in events if kind == "trial"), ["fast", "known", "slow"])
        self.assertEqual(seen[0], ("known", "valid", 3))  # checked in an earlier run: not checked again
        self.assertEqual(seen[-1], ("slow", "valid", 0))


class PipelineTest(unittest.TestCase):
    def test_resume_adds_new_models_after_the_runs_own(self):
        meta = {"models": [{"key": "claude-opus"}, {"key": "glm-5.3"}]}
        self.assertEqual(pipeline.resumed_models(meta, None), (["claude-opus", "glm-5.3"], []))
        self.assertEqual(pipeline.resumed_models(meta, ["glm-5.3", "muse-spark"]),
                         (["claude-opus", "glm-5.3", "muse-spark"], ["muse-spark"]))

    def test_resume_keeps_the_runs_own_judge(self):
        self.assertEqual(pipeline.resumed_judge({"judge": None}, "default"), "none")  # no judge key needed
        self.assertEqual(pipeline.resumed_judge({"judge": {"model": "gpt-x"}}, "default"), "gpt-x")
        self.assertEqual(pipeline.resumed_judge({"judge": None}, "gpt-y"), "gpt-y")  # named on the command line
        self.assertEqual(pipeline.resumed_judge({}, "default"), "default")  # a run from before judges were recorded

    def job(self, d, request):
        from unittest import mock
        with mock.patch.object(pipeline.runtime, "workspace", return_value="test-eval"):
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
        cleanup.assert_called_once_with("r1", workspace="test-eval")  # only this run's sandbox workspace
        self.assertEqual(meta["status"]["phase"], "stopped")
        self.assertEqual(meta["request"]["repos"], ["o/r"])  # what resume needs to start over
        self.assertEqual(meta["tasks"], [])

    def test_tasks_join_the_run_as_their_checks_pass(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            job = self.job(d, pipeline.Request(repos=["o/r"]))
            saved = []

            def check_and_run(candidates, *_, on_checked, on_result):
                on_checked(candidates[0], "valid", 1)
                meta = pipeline.Job(job.path).meta
                saved.append((meta["status"]["phase"], meta["tasks"]))
                on_checked(candidates[1], "reference-fails", 0)
            with mock.patch.object(runner, "check_and_run", side_effect=check_and_run), \
                    mock.patch.object(pipeline, "image_claude_version", return_value="2.1.0"), \
                    mock.patch.object(pipeline.report, "build"), contextlib.redirect_stdout(io.StringIO()):
                pipeline.check_and_run(job, [SimpleNamespace(id="a"), SimpleNamespace(id="b")],
                                       [baseten_model()], runner.Settings())
                meta = pipeline.Job(job.path).meta
            with tempfile.TemporaryDirectory() as other, \
                    mock.patch.object(runner, "check_and_run",
                                      side_effect=lambda c, *_, on_checked, **__: on_checked(c[0], "setup-error", 0)), \
                    mock.patch.object(pipeline, "image_claude_version", return_value=None), \
                    mock.patch.object(pipeline.report, "build"), \
                    contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(SystemExit, "None of the 1"):
                pipeline.check_and_run(self.job(other, pipeline.Request()), [SimpleNamespace(id="c")],
                                       [baseten_model()], runner.Settings())
        self.assertEqual(saved, [("checking", ["a"])])  # saved while b was still being checked
        self.assertEqual((meta["tasks"], meta["left_out"], meta["checked"]), (["a"], {"b": "reference-fails"}, True))
        self.assertEqual(meta["status"]["phase"], "running")

    def test_resume_runs_again_the_attempts_lost_to_infrastructure(self):
        model, task = baseten_model(), SimpleNamespace(id="t")
        reasons = {1: "sandbox-error", 2: "verifier-setup-timeout", 3: "provider-error", 4: "runner-error: boom",
                   5: "verifier-apply-error", 6: "verifier-timeout", 7: "agent-crashed", 8: "judge-error", 9: None}
        with tempfile.TemporaryDirectory() as d:
            for attempt, reason in reasons.items():
                path = Path(d) / "trials" / runner.trial_name(task, model, attempt)
                path.mkdir(parents=True)
                (path / "result.json").write_text(json.dumps(
                    {"outcome": "invalid" if reason else "solved", "invalid_reason": reason}))
            pending = runner.pending_trials([task], [model], 10, Path(d))
            self.assertEqual(runner.lost_trials(Path(d)), 4)
        # Only infrastructure: a diff that won't apply or tests that hang may be the model's doing.
        self.assertEqual([attempt for _, _, attempt, _ in pending], [1, 2, 3, 4, 10])

    def test_a_resumed_run_still_lists_the_prs_it_left_out_before(self):
        job = SimpleNamespace(meta={"left_out": {"old": "reference-fails"}})
        with contextlib.redirect_stdout(io.StringIO()):
            pipeline.leave_out(job, {"a": "valid", "b": "base-passes"})  # resume checks only the kept tasks
            self.assertEqual(job.meta["left_out"], {"old": "reference-fails", "b": "base-passes"})
            pipeline.leave_out(job, {"old": "valid", "b": "valid"})  # checked again, and passing now
        self.assertEqual(job.meta["left_out"], {})

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
                                                       "backend": "blaxel", "workspace": "test-eval",
                                                       "models": [], "status": {"phase": "running", "pid": 999999}}))
            (dead / "log.txt").write_text("cloning o/r\nTraceback: boom\n")
            page = app.App(jobs)
            old_run, dead_run = page.describe(old), page.describe(dead)
        self.assertEqual((old_run["phase"], old_run["title"], old_run["progress"]), ("done", "o/r", {"done": 1, "total": 1}))
        self.assertEqual(dead_run["phase"], "stopped")
        self.assertTrue(dead_run["resumable"])
        self.assertIn("boom", dead_run["log"])

    def test_the_hosted_page_refuses_private_repositories(self):
        from unittest import mock
        page = app.App(Path("/nonexistent"))
        with mock.patch.object(app.tasks, "gh", return_value={"private": True, "language": "Go"}):
            self.assertNotIn("error", page.repo_info("o/r"))
            with mock_env(PR_EVAL_PUBLIC_REPOS_ONLY="1"):
                self.assertIn("public repositories only", page.repo_info("o/r")["error"])
        with mock.patch.object(app.tasks, "gh", return_value={"private": False, "language": "Go"}), \
                mock_env(PR_EVAL_PUBLIC_REPOS_ONLY="1"):
            self.assertNotIn("error", page.repo_info("o/r"))

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

    def test_pages_hide_docker_wording(self):
        page = app.PAGE.read_text()
        self.assertNotIn("Docker", page)
        self.assertIn('c.blaxel, "Dedicated Blaxel workspace is connected"', page)
        self.assertNotIn('${run.image}', report.TEMPLATE.read_text())

    def test_report_header_omits_judge_metadata(self):
        template = report.TEMPLATE.read_text()
        header = template.split("// ---------- header + headline ----------", 1)[1].split("const closed =", 1)[0]
        self.assertNotIn("run.judge", header)
        self.assertNotIn("Tests only, no judge", header)
        self.assertIn("if (r.judge)", template)  # keep verdicts in the attempt details

    def test_total_timing_distinguishes_parallel_work_from_elapsed_time(self):
        trials = [
            {"started_at": "2026-10-20T00:00:00+00:00", "finished_at": "2026-10-20T00:00:10+00:00",
             "agent": {"seconds": 8, "working_seconds": 6}},
            {"started_at": "2026-10-20T00:00:05+00:00", "finished_at": "2026-10-20T00:00:15+00:00",
             "agent": {"seconds": 9, "working_seconds": 7}, "outcome": "invalid"},
        ]
        timing = report.summarize_timing(trials)
        self.assertEqual(timing["elapsed_seconds"], 15)  # parallel spans are not added together
        self.assertEqual(timing["total_working_seconds"], 13)  # waits excluded; invalid work still took time
        self.assertEqual(timing["timed_attempts"], 2)
        run = report.summarize_timing(trials, "2026-10-19T23:59:55+00:00")
        self.assertEqual(run["elapsed_seconds"], 20)  # includes setup before the first attempt

    def test_total_timing_does_not_invent_missing_measurements(self):
        self.assertIsNone(report.summarize_timing([])["elapsed_seconds"])
        self.assertIsNone(report.summarize_timing([])["total_working_seconds"])
        partial = report.summarize_timing([
            {"started_at": "2026-10-20T00:00:00+00:00", "finished_at": "2026-10-20T00:00:10+00:00",
             "agent": {"seconds": 8}},
            {"agent": None},
        ])
        self.assertIsNone(partial["elapsed_seconds"])
        self.assertEqual(partial["total_working_seconds"], 8)
        self.assertEqual((partial["timed_attempts"], partial["attempts"]), (1, 2))

    def test_report_has_ranked_cards_and_three_way_task_comparison(self):
        template = report.TEMPLATE.read_text()
        self.assertIn('<ol class="scores" id="scores">', template)
        self.assertIn('rankedModels.forEach((m, rank)', template)
        self.assertIn('metric("Total elapsed time', template)
        self.assertNotIn('Whole run elapsed', template)
        self.assertNotIn('id="run-timing"', template)
        self.assertNotIn('id="lede"', template)
        self.assertNotIn('id="h-scores"', template)
        self.assertNotIn("Ranked by solve rate, then", template)
        self.assertNotIn("Agent time adds up work across all attempts", template)
        for metric in ("pass_at_1", "cost_per_solved", "median_seconds"):
            self.assertIn(f'data-metric="{metric}"', template)
        self.assertIn('aria-describedby="metric-hint"', template)
        self.assertIn('<section aria-labelledby="h-slices" hidden>', template)
        self.assertIn('<section aria-labelledby="h-tasks" hidden>', template)
        self.assertNotIn('How this was measured', template)
        self.assertNotIn('document.getElementById("method")', template)

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

    def test_a_judge_that_cannot_run_is_caught_before_the_run(self):
        self.assertIn("PR_EVAL_TEST_UNSET", self.judge.problem())
        with mock_env(PR_EVAL_TEST_KEY="k"):
            unreachable = Judge(model="m", base_url="http://127.0.0.1:9", api_key_env="PR_EVAL_TEST_KEY")
            self.assertIsNone(unreachable.problem())  # a network hiccup doesn't stop a run

    def test_missing_key_is_an_error_not_a_verdict(self):
        from eval_sandbox import judge
        self.assertIn("error", judge.grade(self.judge, self.task, "diff", {"passed": True}, ""))

    def test_the_judge_asks_for_its_configured_reasoning_effort(self):
        from unittest import mock
        from eval_sandbox import judge
        self.assertEqual(config.load()[1].effort, "high")
        sent = {}

        def respond(request, timeout):
            sent.update(json.loads(request.data))
            return io.BytesIO(json.dumps({"choices": [{"message": {"content": '{"verdict": "pass", "reason": "ok"}'}}]}).encode())
        with tempfile.TemporaryDirectory() as d, mock_env(PR_EVAL_TEST_KEY="k"), \
                mock.patch.object(judge.urllib.request, "urlopen", side_effect=respond):
            (Path(d) / "solution").mkdir()
            (Path(d) / "solution" / "reference.patch").write_text("diff")
            task = tasks.Task(id="x", path=Path(d), meta={"task": {"repo": "a/b"}}, instruction="do it")
            graded = judge.grade(Judge(model="m", base_url="http://x", api_key_env="PR_EVAL_TEST_KEY", effort="high"),
                                 task, "diff", {"passed": True}, "")
        self.assertEqual(sent["reasoning_effort"], "high")
        self.assertEqual((graded["verdict"], graded["effort"]), ("pass", "high"))

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
