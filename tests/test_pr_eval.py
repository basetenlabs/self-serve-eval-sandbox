"""pr-eval unit tests: no Docker, no network, no keys."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval_sandbox import app, cli, config, judge, pipeline, report, runner, tasks, trace  # noqa: E402
from eval_sandbox.config import Judge, Model, Panel  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"


def web_source(entry: str) -> str:
    """A web/ source file, or every file under a web/ folder, as one string."""
    full = WEB / entry
    paths = sorted(p for p in full.rglob("*") if p.is_file()) if full.is_dir() else [full]
    return "\n".join(p.read_text() for p in paths)


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
        self.assertEqual([j.model for j in judge.judges], ["claude-opus-5-5", "gpt-6.1-sol", "moonshotai/Kimi-K3"])
        self.assertEqual(judge.chair.model, "moonshotai/Kimi-K3")

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
                            '[judge]\n[[judge.panel]]\nmodel = "j"\nbase_url = "http://x"\napi_key_env = "K"\n')
            with self.assertRaises(SystemExit) as caught:
                config.load(path)
        self.assertIn("max_concurent", str(caught.exception))

    def test_a_config_from_before_panels_has_its_one_judge(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "models.toml"
            path.write_text('[models.m]\nkind = "open"\nprovider = "baseten"\nmodel = "m"\n'
                            '[judge]\nmodel = "j"\nlabel = "J"\neffort = "high"\nbase_url = "http://x/"\napi_key_env = "K"\n')
            _, panel = config.load(path)
        self.assertEqual([(j.model, j.base_url, j.effort) for j in panel.judges], [("j", "http://x", "high")])
        self.assertIsNone(panel.chair)


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
        posthog = tasks.recipe("PostHog/posthog", "Python", ["posthog/test/test_a.py", "frontend/src/a.test.ts"])
        self.assertTrue(posthog["test"].endswith("pytest -q --tb=short -p no:cacheprovider posthog/test/test_a.py"))
        self.assertIn("UV_LINK_MODE=hardlink", posthog["setup"])
        self.assertEqual(posthog["memory"], 16384)
        with self.assertRaises(tasks.Skip):
            tasks.recipe("PostHog/posthog", "Python", ["frontend/src/a.test.ts"])
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

    def test_the_quick_sample_is_ten_sample_tasks(self):
        sample, quick = tasks.sample(), tasks.sample(quick=True)
        self.assertEqual(sum(map(len, quick.values())), 10)
        self.assertGreaterEqual(len(quick), 6)
        for repo, prs in quick.items():
            self.assertLessEqual(set(prs), set(sample[repo]), repo)
        self.assertEqual(pipeline.Request(quick=True).describe(), "the quick sample")
        self.assertTrue(pipeline.default_name(pipeline.Request(quick=True)).startswith("quick-"))

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

    def test_pull_requests_in_the_forms_people_paste(self):
        for text in ("https://github.com/o/r/pull/12", "github.com/o/r/pull/12/files", " o/r#12 ",
                     "https://github.com/o/r/pull/12#discussion_r1", "https://www.github.com/o/r/pulls/12?w=1"):
            self.assertEqual(tasks.parse_pull(text), ("o/r", 12), text)
        for text in ("o/r", "https://github.com/o/r", "https://github.com/o/r/issues/12", "o/r#x", "#12"):
            self.assertIsNone(tasks.parse_pull(text), text)

    def test_a_pr_fits_when_it_changes_code_and_tests_at_a_reviewable_size(self):
        code, test = {"path": "a.go", "role": "implementation", "lines": 10}, {"path": "a_test.go", "role": "test", "lines": 10}
        self.assertIsNone(tasks.unfit([code, test]))
        self.assertIn("both code and tests", tasks.unfit([code]))
        self.assertIn("too large", tasks.unfit([code, {**test, "lines": tasks.MAX_LINES}]))
        self.assertEqual([tasks.role(p) for p in ("pkg/a_test.go", "src/a.ts", "docs/a.py", "README.md")],
                         ["test", "implementation", "support", "support"])

    def test_recent_prs_say_which_can_be_tasks(self):
        listing = [{"number": n, "title": t, "html_url": f"u{n}", "merged_at": m, "user": {"login": "a"}}
                   for n, t, m in ((1, "Fix parser", "2026-10-02"), (2, "Bump deps", "2026-10-03"), (3, "Open", None))]
        files = {1: [{"filename": "p.go", "additions": 5, "deletions": 1}, {"filename": "p_test.go", "additions": 9, "deletions": 0}],
                 2: [{"filename": "go.mod", "additions": 1, "deletions": 1}]}

        def gh(endpoint, token=None):
            if endpoint.endswith("per_page=100") and "/files" in endpoint:
                return files[int(endpoint.split("/pulls/")[1].split("/")[0])]
            return listing
        with mock.patch.object(tasks, "gh", side_effect=gh):
            rows = tasks.browse("o/r")
            self.assertEqual([r["number"] for r in tasks.browse("o/r", count=1)], [2])  # "Show older merges" asks for more
        self.assertEqual([r["number"] for r in rows], [2, 1])  # merged only, newest first
        self.assertEqual((rows[1]["why"], rows[1]["lines"], rows[1]["tests"]), (None, 15, 1))
        self.assertIn("both code and tests", rows[0]["why"])
        self.assertTrue(rows[0]["maintenance"])
        self.assertTrue(tasks.MAINTENANCE.search("Merge stable into main"))  # a branch sync, not a change to make

        unmerged = [{"number": 100 + n, "merged_at": None} for n in range(100)]  # a page of PRs closed unmerged
        with mock.patch.object(tasks, "gh", side_effect=lambda e, token=None: files[1] if "/files" in e
                               else unmerged if e.endswith("page=1") else listing[:1]):
            self.assertEqual([r["number"] for r in tasks.browse("o/r")], [1])  # found on the next page

        def by_number(endpoint, token=None):
            if "/files" in endpoint:
                return gh(endpoint)
            number = int(endpoint.rsplit("/", 1)[1])
            if number == 404:
                raise RuntimeError("HTTP 404")
            return next(pr for pr in listing if pr["number"] == number)
        with mock.patch.object(tasks, "gh", side_effect=by_number):
            pasted = tasks.browse("o/r", [1, 3, 404])
        self.assertEqual([(r["number"], r["why"]) for r in pasted],
                         [(1, None), (3, "not merged"), (404, "GitHub has no such pull request")])

    def test_searching_a_repositorys_merged_prs(self):
        found = {"items": [{"number": 7}, {"number": 3}]}
        with mock.patch.object(tasks, "gh", return_value=found) as gh:
            self.assertEqual(tasks.search("o/r", "  context  binding! ", "tok"), [7, 3])
            self.assertEqual(tasks.search("o/r", "#42"), [42])  # a number is that pull request, no search
            self.assertEqual(tasks.search("o/r", "!!"), [])
        endpoint, token = gh.call_args.args
        self.assertIn("q=repo%3Ao/r%20is%3Apr%20is%3Amerged%20context%20binding&", endpoint)
        self.assertEqual((gh.call_count, token), (1, "tok"))

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


    def test_caches_from_running_code_are_not_part_of_the_diff(self):
        import subprocess
        import tarfile
        with tempfile.TemporaryDirectory() as d:
            work, source = Path(d) / "workspace", Path(d) / "source.tar.gz"
            work.mkdir()
            (Path(d) / "lib.py").write_text("old\n")
            with tarfile.open(source, "w:gz") as tar:  # an archive without the repository's .gitignore
                tar.add(Path(d) / "lib.py", "lib.py")

            def local_sh(container, script, *, timeout, **_):  # /workspace and /tmp, here
                script = script.replace("/tmp/source.tar.gz", str(source)).replace("/workspace", str(work))
                p = subprocess.run(["bash", "-c", script], cwd=work, capture_output=True, text=True,
                                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull})
                return p.returncode, p.stdout + p.stderr, False
            task = tasks.Task(id="t", path=Path(d), instruction="", meta={"environment": {
                "setup": "mkdir -p __pycache__ && echo setup > __pycache__/lib.cpython-314.pyc"}})
            with mock.patch.object(runner, "sh", local_sh), mock.patch.object(runner, "snapshot", return_value=source), \
                    mock.patch.object(runner.runtime, "upload"), mock.patch.object(runner, "block_lookups"):
                reason, setup = runner.prepare_workspace("unused", task, Path(d))
                self.assertIsNone(reason)
                local_sh(None, "echo new > lib.py && echo run > __pycache__/lib.cpython-314.pyc && "
                               "mkdir -p .pytest_cache && echo x > .pytest_cache/v", timeout=9)
                with mock.patch.object(runner.runtime, "download",
                                       side_effect=lambda c, remote, local, **_: local.write_bytes(
                                           Path(remote.replace("/workspace", str(work))).read_bytes())):
                    patch, numstat = runner.capture_patch("unused", setup["baseline"], Path(d) / "agent.patch")
        self.assertIn("+new", patch)
        self.assertEqual(runner.diff_stats(numstat)["files"], 1)

    def test_a_setup_whose_download_dropped_is_tried_again(self):
        task = tasks.Task(id="t", path=Path("/nonexistent"), instruction="", meta={"environment": {"setup": "SETUP"}})
        eof = (1, 'go: read "https://proxy.golang.org/x.zip": unexpected EOF', False)
        for setups, expected in (([eof, eof, (0, "ok", False)], None),
                                 ([eof, eof, eof], "setup-error"),
                                 ([(1, "no such module", False)], "setup-error"),  # not a download: not again
                                 ([(1, "", True)], "setup-timeout")):  # nor after a timeout
            answers = list(setups)
            def fake_sh(container, script, *, timeout):
                if script == "SETUP":
                    return answers.pop(0)
                return 0, "a" * 40 if "rev-parse" in script else "", False
            with tempfile.TemporaryDirectory() as d, mock.patch.object(runner, "sh", fake_sh), \
                    mock.patch.object(runner, "snapshot"), mock.patch.object(runner.runtime, "upload"), \
                    mock.patch.object(runner, "block_lookups"), mock.patch.object(runner.time, "sleep"):
                reason, _ = runner.prepare_workspace("unused", task, Path(d))
                log = (Path(d) / "setup.log").read_text()
            self.assertEqual((reason, answers), (expected, []))
            self.assertIn(setups[0][1], log)

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

    def test_the_hidden_tests_run_in_a_network_of_their_own(self):
        task = tasks.Task(id="t", path=Path("/nonexistent"), instruction="", meta={"verifier": {}})
        compile(runner.OWN_NETWORK, "own-network", "exec")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(runner.runtime, "upload"):
            with mock.patch.object(runner, "sh", return_value=(0, "1 passed", False)) as sh:
                self.assertTrue(runner.run_tests("unused", task, Path(d) / "tests.log")["passed"])
            script = sh.call_args.args[1]
            self.assertTrue(script.startswith("python3 -c ") and script.endswith(" bash /tests/test.sh"))
            # without one, the attempt is lost to infrastructure, not failed
            refused = (1, "pr-eval: no network of their own for the tests: Operation not permitted", False)
            with mock.patch.object(runner, "sh", return_value=refused), self.assertRaises(runner.runtime.RuntimeError):
                runner.run_tests("unused", task, Path(d) / "tests.log")
            # a check from before is made again
            (Path(d) / "validation").mkdir()
            (Path(d) / "validation" / "result.json").write_text(json.dumps(
                {"backend": "blaxel", "workspace": "w", "image": "i", "region": "r", "status": "reference-fails"}))
            checked = tasks.Task(id="t", path=Path(d), instruction="", meta={})
            settings = runner.Settings(image="i", region="r", workspace="w")
            self.assertIsNone(runner.validation_status(checked, settings))
            self.assertEqual(runner.validation_status(checked), "reference-fails")

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
        panel = Panel([Judge(model="a"), Judge(model="b")], Judge(model="b"))
        self.assertEqual(pipeline.resumed_judge({"judge": panel.as_dict()}, "default"), "default")
        self.assertEqual(pipeline.resumed_judge({"judge": Panel([Judge(model="a")]).as_dict()}, "default"), "a")

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
        self.assertTrue(pipeline.default_name(pipeline.Request(pulls={"o/picked": [1]})).startswith("picked-"))
        self.assertTrue(pipeline.default_name(pipeline.Request()).startswith("sample-"))

    def test_pasted_prs_are_collected_by_number_from_each_repository(self):
        request = pipeline.Request(repos=["o/scan"], pulls={"o/a": [1, 2], "x/b": [9]}, limit=3)
        with mock.patch.object(pipeline.tasks, "collect", return_value=[]) as collect, \
                mock.patch.object(pipeline.tasks, "load"):
            pipeline.find_tasks(request, Path("/nonexistent"))
        asked = {c.args[0]: c.kwargs["prs"] for c in collect.call_args_list}
        self.assertEqual(asked, {"o/scan": None, "o/a": [1, 2], "x/b": [9]})
        self.assertEqual(request.describe(), "o/scan, o/a, x/b")
        self.assertEqual(pipeline.Request(**json.loads(json.dumps(pipeline.asdict(request)))), request)  # resumes

    def test_the_command_line_takes_pr_links_beside_repositories(self):
        args = SimpleNamespace(repos=["o/scan", "https://github.com/o/a/pull/1", "o/a#2", "x/b#9"], pr=None)
        self.assertEqual(cli.wanted(args), (["o/scan"], {"o/a": [1, 2], "x/b": [9]}))
        with self.assertRaises(SystemExit):
            cli.wanted(SimpleNamespace(repos=["o/a#1"], pr=[3]))  # --pr still needs one repository to scan


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

    def test_the_board_shows_each_attempt_live(self):
        with tempfile.TemporaryDirectory() as d:
            jobs, tasks_dir = Path(d) / "jobs", Path(d) / "tasks"
            for task_id, pr in (("o__r-1", 1), ("o__r-2", 2), ("o__r-3", 3)):
                (tasks_dir / task_id / "validation").mkdir(parents=True)
                (tasks_dir / task_id / "task.toml").write_text(
                    f'[task]\nid = "{task_id}"\nrepo = "o/r"\npr_number = {pr}\ntitle = "Fix {pr}"\nlanguage = "Go"\n')
            job = jobs / "quick-1"
            (job / "trials" / "o__r-1__m__1").mkdir(parents=True)
            (job / "trials" / "o__r-1__m__1" / "stage.json").write_text(json.dumps({"stage": "agent", "at": "x"}))
            (job / "trials" / "o__r-2__m__1").mkdir(parents=True)
            (job / "trials" / "o__r-2__m__1" / "result.json").write_text(json.dumps(
                {"outcome": "solved", "started_at": "2026-10-23T18:00:00+00:00", "finished_at": "2026-10-23T18:02:05+00:00",
                 "agent": {"cost_usd": 0.5}, "tests": {"passed": True}, "judge": {"verdict": "pass"}}))
            (tasks_dir / "o__r-3" / "validation" / "stage.json").write_text(json.dumps({"stage": "base", "run_id": "quick-1"}))
            (job / "run.json").write_text(json.dumps({
                "run_id": "quick-1", "request": {"quick": True}, "candidates": ["o__r-1", "o__r-2", "o__r-3"],
                "tasks": ["o__r-1", "o__r-2"], "tasks_dir": str(tasks_dir), "models": [{"key": "m", "label": "M"}],
                "status": {"phase": "checking", "pid": os.getpid()}}))
            page = app.App(jobs)
            with mock.patch.object(app, "alive", return_value=True):
                run = page.describe(job)
                board = page.board(run)
        self.assertEqual(run["title"], "Quick sample")
        self.assertEqual(run["again"], {"quick": True, "models": ["m"]})
        rows = {r["id"]: r for r in board["rows"]}
        self.assertEqual(rows["o__r-1"]["title"], "Fix 1")
        self.assertEqual(rows["o__r-1"]["cells"][0]["stage"], "agent")
        self.assertEqual((rows["o__r-2"]["cells"][0]["stage"], rows["o__r-2"]["cells"][0]["seconds"]), ("solved", 125))
        self.assertEqual((rows["o__r-3"]["check"]["stage"], rows["o__r-3"]["cells"][0]["stage"]), ("base", "waiting"))
        self.assertEqual(board["sandboxes"], app.SANDBOXES["agent"] + 1)  # the agent's two, and the check's one

    def test_run_again_brings_back_the_same_prs_models_and_commands(self):
        models = [{"key": "a", "label": "A", "model": "org/A-1017"}, {"key": "b", "label": "B"}]
        latest = {"request": {"repos": ["o/my-repo"], "limit": 10, "setup": "npm ci", "test": "npx t"}, "models": models,
                  "candidates": ["o__my-repo-1", "o__my-repo-2", "o__my-repo-3"], "tasks": ["o__my-repo-3", "o__my-repo-1"]}
        # the PRs the check kept, not the repository's latest merges, which move on
        self.assertEqual(app.again(latest), {"pulls": {"o/my-repo": [3, 1]}, "setup": "npm ci", "test": "npx t", "models": ["a", "b"]})
        stopped = {"request": {"pulls": {"o/r": [5], "x/y": [2]}}, "candidates": ["o__r-5", "x__y-2"], "tasks": [], "models": []}
        self.assertEqual(app.again(stopped)["pulls"], {"o/r": [5], "x/y": [2]})  # stopped while checking
        self.assertIsNone(app.again({"request": {"repos": ["o/r"]}, "models": models}))  # stopped before it found any
        self.assertIsNone(app.again({"tasks": [f"o__r-{n}" for n in range(1, app.MAX_LIMIT + 2)], "models": models}))

    def test_the_hosted_page_refuses_private_repositories(self):
        page = app.App(Path("/nonexistent"))
        with mock.patch.object(app.tasks, "gh", return_value={"private": True, "language": "Go"}):
            self.assertNotIn("error", page.repo_info("o/r"))
            with mock_env(PR_EVAL_PUBLIC_REPOS_ONLY="1"):
                self.assertIn("public repositories only", page.repo_info("o/r")["error"])
        with mock.patch.object(app.tasks, "gh", return_value={"private": False, "language": "Go"}), \
                mock_env(PR_EVAL_PUBLIC_REPOS_ONLY="1"):
            self.assertNotIn("error", page.repo_info("o/r"))

    def test_signing_in_with_github_reads_private_repositories_for_that_person(self):
        page = app.App(Path("/nonexistent"))
        with mock.patch.object(app.tasks, "gh", return_value={"private": True, "language": "Go"}) as gh, \
                mock.patch.object(app, "GITHUB_CLIENT_ID", "client"), mock_env(PR_EVAL_PUBLIC_REPOS_ONLY="1"):
            self.assertIn("Sign in with GitHub", page.repo_info("o/r", "a@x.co")["error"])
            page.github["a@x.co"] = {"token": "tok-a", "login": "ana", "until": app.time.monotonic() + 60}
            self.assertNotIn("error", page.repo_info("o/r", "a@x.co"))
            self.assertEqual(gh.call_args.args, ("repos/o/r", "tok-a"))
            self.assertIn("Sign in with GitHub", page.repo_info("o/r", "b@x.co")["error"])  # only for the one who signed in
            self.assertEqual(page.github_state("a@x.co"), {"sign_in": True, "login": "ana"})
            page.github["a@x.co"]["until"] = 0  # GitHub's token expired
            self.assertEqual(page.github_state("a@x.co"), {"sign_in": True, "login": None})

    def test_the_github_sign_in_waits_for_the_person_to_approve_it(self):
        page = app.App(Path("/nonexistent"))
        answers = [{"device_code": "dev", "user_code": "AB-12", "verification_uri": "https://github.com/login/device",
                    "interval": 5, "expires_in": 900},
                   {"error": "authorization_pending"}, {"error": "slow_down"},
                   {"access_token": "tok", "expires_in": 28800}]
        with mock.patch.object(app, "GITHUB_CLIENT_ID", "client"), \
                mock.patch.object(app, "github_form", side_effect=answers) as form, \
                mock.patch.object(app.tasks, "gh", return_value={"login": "ana"}):
            self.assertEqual(page.github_device("a@x.co")["user_code"], "AB-12")
            self.assertEqual(form.call_args.args[1], {"client_id": "client", "scope": "repo"})
            self.assertEqual(page.github_state("a@x.co")["device"]["user_code"], "AB-12")  # a reloaded page shows it again
            self.assertEqual(page.github_poll("a@x.co"), {"pending": True, "interval": 5})
            self.assertEqual(page.github_poll("a@x.co"), {"pending": True, "interval": 10})  # GitHub asked to slow down
            self.assertEqual(page.github_poll("a@x.co"), {"login": "ana"})
        self.assertEqual(page.token("a@x.co"), "tok")
        self.assertEqual(page.github_state("a@x.co"), {"sign_in": False, "login": "ana"})  # no code waiting; no client id here
        self.assertIn("expired", page.github_poll("a@x.co")["error"])  # nothing is waiting any more
        page.github_sign_out("a@x.co")
        self.assertIsNone(page.token("a@x.co"))
        self.assertIn("isn't set up", page.github_device("a@x.co")["error"])  # locally: no client id, gh's login reads

    def test_a_private_run_is_seen_only_by_who_started_it(self):
        with tempfile.TemporaryDirectory() as d:
            jobs = Path(d) / "jobs"
            for run_id in ("open", "mine"):
                (jobs / run_id).mkdir(parents=True)
                (jobs / run_id / "run.json").write_text(json.dumps({"run_id": run_id, "tasks": [], "models": []}))
            (jobs / "mine" / app.ACCESS).write_text(json.dumps({"owner": "a@x.co", "private": True}))
            (jobs / "mine" / "report.json").write_text("{}")
            page = app.App(jobs)
            with mock.patch.object(page, "checks", return_value={"blaxel": True}), \
                    mock.patch.object(app.config, "load", return_value=({}, SimpleNamespace(problem=lambda: None))):
                seen = {u: sorted(r["id"] for r in page.state(user=u)["runs"]) for u in ("a@x.co", "b@x.co", None)}
            self.assertEqual(seen, {"a@x.co": ["mine", "open"], "b@x.co": ["open"], None: ["open"]})
            self.assertIsNone(page.find("mine", "b@x.co"))
            self.assertEqual(page.stop("mine", "b@x.co"), page.stop("nope", "b@x.co"))  # as if it weren't there
            (jobs / "mine" / "trials" / "t__m__1").mkdir(parents=True)
            self.assertNotIn("no trace", page.trace("mine", "t__m__1", "b@x.co")["error"])  # no such attempt, for them
            self.assertIn("no trace", page.trace("mine", "t__m__1", "a@x.co")["error"])  # there, not yet traced

    def test_a_run_on_a_private_repository_belongs_to_its_starter(self):
        with tempfile.TemporaryDirectory() as d:
            page = app.App(Path(d))
            page.github["a@x.co"] = {"token": "tok-a", "login": "ana", "until": app.time.monotonic() + 60}
            ready = {"busy": False, "runs": [], "checks": {"blaxel": True, "bl_cli": True, "gh": True}}
            with mock.patch.object(page, "state", return_value=ready), mock.patch.object(page, "spawn") as spawn, \
                    mock.patch.object(app.pipeline, "preflight"), \
                    mock.patch.object(page, "repo_info", return_value={"repo": "o/a", "defaults": True, "private": True}):
                started = page.start({"pulls": {"o/a": [1]}, "models": ["m"]}, "a@x.co")
            access = json.loads((Path(d) / started["id"] / app.ACCESS).read_text())
        self.assertEqual(access, {"owner": "a@x.co", "private": True})
        self.assertEqual(spawn.call_args.args[2], "tok-a")  # it clones with their GitHub sign-in

    def test_favorite_prs_are_kept_per_person_newest_first(self):
        with tempfile.TemporaryDirectory() as d:
            page = app.App(Path(d) / "jobs")
            page.favorite({"repo": "o/r", "number": 1, "title": "One", "saved": True}, "a@x.co")
            page.favorite({"repo": "https://github.com/o/r", "number": 2, "title": "Two", "saved": True}, "a@x.co")
            page.favorite({"repo": "O/R", "number": 1, "title": "One", "saved": True}, "a@x.co")  # saved again: first
            page.favorite({"repo": "x/y", "number": 9, "saved": True})  # locally, no one in particular
            self.assertEqual([(f["repo"], f["number"]) for f in app.App(Path(d) / "jobs").favorites("a@x.co")],
                             [("O/R", 1), ("o/r", 2)])  # kept on disk, once each
            page.favorite({"repo": "o/r", "number": 1, "saved": False}, "a@x.co")
            self.assertEqual([f["number"] for f in page.favorites("a@x.co")], [2])
            self.assertEqual([f["number"] for f in page.favorites(None)], [9])
            self.assertEqual(page.favorites("b@x.co"), [])
            for bad in ({"repo": "nope", "number": 1}, {"repo": "o/r", "number": "1"}, {"repo": "o/r", "number": 0}):
                self.assertIn("error", page.favorite({**bad, "saved": True}, "a@x.co"))

    def test_finding_prs_by_words(self):
        page = app.App(Path("/nonexistent"))
        with mock.patch.object(page, "repo_info", return_value={"repo": "o/r"}), \
                mock.patch.object(app.tasks, "search", return_value=[7, 3]) as search, \
                mock.patch.object(app.tasks, "browse", return_value=[{"number": 7}, {"number": 3}]) as browse:
            self.assertEqual(page.pulls("o/r", words="binding")["prs"], [{"number": 7}, {"number": 3}])
            search.return_value = []
            self.assertEqual(page.pulls("o/r", words="nothing like it")["prs"], [])
        self.assertEqual(browse.call_args.args[:2], ("o/r", [7, 3]))
        self.assertEqual(search.call_count, 2)

    def test_picked_prs_become_the_runs_arguments(self):
        self.assertEqual(app.App.chosen_pulls({"https://github.com/o/a": [2, 1, 2], "x/b": [9], "y/c": []}),
                         {"o/a": [1, 2], "x/b": [9]})
        for bad in ({"o/a": ["1"]}, {"o/a": [0]}, {"not a repo": [1]}, {"o/a": list(range(1, app.MAX_LIMIT + 2))}):
            self.assertIsInstance(app.App.chosen_pulls(bad), str, bad)
        with tempfile.TemporaryDirectory() as d:
            page = app.App(Path(d))
            ready = {"busy": False, "checks": {"blaxel": True, "bl_cli": True, "gh": True}}
            with mock.patch.object(page, "state", return_value=ready), mock.patch.object(page, "spawn") as spawn, \
                    mock.patch.object(app.pipeline, "preflight"), \
                    mock.patch.object(page, "repo_info", return_value={"repo": "o/a", "defaults": True}):
                started = page.start({"pulls": {"o/a": [3, 1]}, "models": ["m"]})
                refused = page.start({"pulls": {"o/a": [1], "x/b": [2]}, "models": ["m"], "setup": "npm ci", "test": "npx t"})
        self.assertTrue(started["id"].startswith("a-"))
        self.assertEqual(spawn.call_args.args[1], ["o/a#1", "o/a#3", "--models", "m", "--name", started["id"]])
        self.assertIn("one repository", refused["error"])

    def test_the_page_serves_reports_and_traces_but_not_raw_logs(self):
        import http.client
        with tempfile.TemporaryDirectory() as d:
            trial = Path(d) / "r1" / "trials" / "t__m__1"
            trial.mkdir(parents=True)
            (trial / "agent.jsonl").write_text("{}\n")
            (Path(d) / "r1" / "report.json").write_text("{}")
            (Path(d) / "r2").mkdir()  # someone's run on a private repository
            (Path(d) / "r2" / "report.json").write_text("{}")
            (Path(d) / "r2" / app.ACCESS).write_text(json.dumps({"owner": "a@x.co", "private": True}))
            handler = type("H", (app.Handler,), {"app": app.App(Path(d))})
            server = app.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            port = server.server_address[1]

            def get(path, headers=None):
                conn = http.client.HTTPConnection("127.0.0.1", port)
                conn.request("GET", path, headers=headers or {})
                response = conn.getresponse()
                return response.status, response.read()
            try:
                self.assertEqual(get("/r1/report.json")[0], 200)
                self.assertEqual(get("/r2/report.json")[0], 404)
                self.assertEqual(get("/r2/report.json", {"x-forwarded-email": "b@x.co"})[0], 404)
                self.assertEqual(get("/r2/report.json", {"x-forwarded-email": "a@x.co"})[0], 200)
                # The old gateway's header is just another header now: sending it names no one.
                self.assertEqual(get("/r2/report.json", {"x-pr-eval-user": "a@x.co"})[0], 404)
                self.assertEqual(get("/r1/trials/t__m__1/agent.jsonl")[0], 404)
                self.assertEqual(get("/r1/run.json")[0], 404)
                status, body = get("/api/trace?run=r1&trial=t__m__1")
                self.assertEqual((status, json.loads(body)["steps"]), (200, []))
                self.assertEqual(get("/api/trace?run=..&trial=r1")[0], 400)
            finally:
                server.shutdown()
                server.server_close()

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
                # Hosted, the browser's Origin is the public site's, and only that one.
                with mock.patch.object(app, "APP_ORIGIN", "https://eval.example"):
                    self.assertEqual(post({"content-type": "application/json", "origin": "https://eval.example"}), 400)
                    self.assertEqual(post({"content-type": "application/json", "origin": "https://other.example"}), 403)
                    self.assertEqual(post({"content-type": "application/json", "origin": "https://eval.example.evil"}), 403)
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

    def test_a_run_from_another_machine_reads_this_checkouts_tasks(self):
        with tempfile.TemporaryDirectory() as d:
            job, tasks_dir = Path(d) / "job", Path(d) / "tasks"
            (job / "trials" / "o__r-1__m__1").mkdir(parents=True)
            (job / "trials" / "o__r-1__m__1" / "result.json").write_text(json.dumps(self.trial("o__r-1", "m", "solved", 1.0)))
            (job / "run.json").write_text(json.dumps({"run_id": "job", "models": [{"key": "m", "label": "M"}], "attempts": 1,
                                                       "tasks": ["o__r-1"], "tasks_dir": "/Users/someone-else/tasks"}))
            (tasks_dir / "o__r-1").mkdir(parents=True)
            (tasks_dir / "o__r-1" / "instruction.md").write_text("# Fix it\n")
            (tasks_dir / "o__r-1" / "task.toml").write_text(
                '[task]\nid = "o__r-1"\nrepo = "o/r"\npr_number = 1\nurl = "u"\ntitle = "Fix it"\nlanguage = "Go"\n'
                'size_bucket = "small"\nlines_changed = 3\nfiles_changed = 1\nmerged_at = "2026-10-20"\n[verifier]\ntest = "go test"\n')
            with mock.patch.object(report, "DEFAULT_TASKS", tasks_dir):
                data = report.build_data(job)
        self.assertEqual(data["tasks"][0]["repo"], "o/r")

    def test_pages_hide_docker_wording(self):
        page = app.PAGE.read_text()
        self.assertNotIn("Docker", page)
        self.assertNotIn("Docker", report.TEMPLATE.read_text())
        self.assertIn("Dedicated Blaxel workspace", page)
        self.assertNotIn("run.image", web_source("src/features/report"))  # the trial image stays out of reports

    def test_report_header_omits_judge_metadata(self):
        view = web_source("src/features/report/ReportView.tsx")
        header = view.split("export function reportFacts", 1)[1].split("export function Banners", 1)[0]
        self.assertNotIn("judge", header.lower())
        self.assertIn("if (r.judge)", web_source("src/features/report/TaskSheet.tsx"))  # verdicts stay in the attempt details

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

    def test_wall_clock_leaves_out_the_time_a_stopped_run_sat_idle(self):
        trials = [
            {"started_at": "2026-10-20T00:00:00+00:00", "finished_at": "2026-10-20T00:10:00+00:00"},
            {"started_at": "2026-10-20T00:05:00+00:00", "finished_at": "2026-10-20T00:12:00+00:00"},
            {"started_at": "2026-10-21T09:00:00+00:00", "finished_at": "2026-10-21T09:03:00+00:00"},  # resumed next day
        ]
        self.assertEqual(report.summarize_timing(trials)["elapsed_seconds"], 15 * 60)
        self.assertEqual(report.summarize_timing(trials, "2026-10-19T23:58:00+00:00")["elapsed_seconds"], 17 * 60)

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
        for heading in ("Head to head", "All models", "Quality against cost", "By task type", "Total wall clock"):
            self.assertIn(heading, template)
        view = web_source("src/features/report")
        for metric in ("pass_at_1", "cost_per_solved", "median_seconds"):
            self.assertIn(f'"{metric}"', view)
        self.assertIn("Agent's diff", template)
        self.assertIn("Merged diff", template)
        self.assertNotIn("How this was measured", template)

    def test_built_pages_match_their_sources(self):
        # Each page carries a hash of the web/ sources it was built from (web/build.ts computes it the
        # same way). A mismatch means web/ changed without `cd web && npm ci && npm run build`.
        digest = hashlib.sha256()
        files = []
        for entry in ("src", "index.html", "report.html", "vite.config.ts", "build.ts", "package-lock.json"):
            full = WEB / entry
            files += [p for p in full.rglob("*") if p.is_file()] if full.is_dir() else [full]
        for rel in sorted(p.relative_to(WEB).as_posix() for p in files):
            digest.update(rel.encode() + b"\0" + (WEB / rel).read_bytes() + b"\0")
        for page in (app.PAGE, report.TEMPLATE):
            built = page.read_text().partition('<meta name="pr-eval-build" content="')[2][:64]
            self.assertEqual(built, digest.hexdigest(), f"{page.name} is stale: run `cd web && npm run build`")

    def test_report_template_keeps_one_slot_for_data_and_title(self):
        template = report.TEMPLATE.read_text()
        self.assertEqual(template.count("__REPORT_DATA__"), 1)
        self.assertEqual(template.count("__REPORT_TITLE__"), 1)
        self.assertNotIn("__REPORT_DATA__", app.PAGE.read_text())

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


def judged_task(d: str) -> tasks.Task:
    (Path(d) / "solution").mkdir()
    (Path(d) / "solution" / "reference.patch").write_text("diff")
    return tasks.Task(id="x", path=Path(d), meta={"task": {"repo": "a/b"}}, instruction="do it")


def chat_reply(content: str):
    return io.BytesIO(json.dumps({"choices": [{"message": {"content": content}}]}).encode())


class JudgeTest(unittest.TestCase):
    task = tasks.Task(id="x", path=Path("/nonexistent"), meta={"task": {"repo": "a/b"}}, instruction="do it")
    judge = Judge(model="m", base_url="http://localhost:9", api_key_env="PR_EVAL_TEST_UNSET")

    def test_a_judge_that_cannot_run_is_caught_before_the_run(self):
        self.assertIn("PR_EVAL_TEST_UNSET", self.judge.problem())
        with mock_env(CLAUDE_CODE_OAUTH_TOKEN="t"), mock.patch.object(config.shutil, "which", return_value="/bin/claude"):
            self.assertIn("PR_EVAL_TEST_UNSET", Panel([Judge(model="c", provider="anthropic"), self.judge]).problem())
        with mock_env(PR_EVAL_TEST_KEY="k"):
            unreachable = Judge(model="m", base_url="http://127.0.0.1:9", api_key_env="PR_EVAL_TEST_KEY")
            self.assertIsNone(unreachable.problem())  # a network hiccup doesn't stop a run

    def test_a_claude_judge_needs_claude_code(self):
        with mock.patch.object(config.shutil, "which", return_value=None):
            self.assertIn("runs through Claude Code", Judge(model="claude-x", provider="anthropic", label="C").problem())

    def test_missing_key_is_an_error_not_a_verdict(self):
        with tempfile.TemporaryDirectory() as d:
            graded = judge.grade(Panel([self.judge]), judged_task(d), "diff", {"passed": True}, "")
        self.assertIn("PR_EVAL_TEST_UNSET", graded["error"])
        self.assertNotIn("verdict", graded)

    def test_the_judge_asks_for_its_configured_reasoning_effort(self):
        self.assertEqual({j.effort for j in config.load()[1].judges}, {"high"})
        sent = {}

        def respond(request, timeout):
            sent.update(json.loads(request.data))
            return chat_reply('{"verdict": "pass", "reason": "ok"}')
        with mock_env(PR_EVAL_TEST_KEY="k"), mock.patch.object(judge.urllib.request, "urlopen", side_effect=respond):
            graded = judge.ask_chat(Judge(model="m", base_url="http://x", api_key_env="PR_EVAL_TEST_KEY", effort="high"),
                                    "system", "user")
        self.assertEqual((sent["reasoning_effort"], sent["response_format"]), ("high", {"type": "json_object"}))
        self.assertEqual(graded["verdict"], "pass")

    def test_judges_read_text_changes_and_only_the_names_of_binary_ones(self):
        cache = "diff --git a/x.pyc b/x.pyc\nnew file mode 100644\nGIT binary patch\nliteral 9\nzcmV\n\n"
        code = "diff --git a/lib.py b/lib.py\n--- a/lib.py\n+++ b/lib.py\n@@ -1 +1 @@\n-old\n+new\n"
        shown = judge.readable(cache * 3 + code)
        self.assertTrue(shown.startswith(code))
        self.assertIn("[3 binary files not shown: x.pyc, x.pyc, x.pyc]", shown)
        self.assertEqual(judge.readable(code), code)

    def test_a_verdict_is_read_from_a_fenced_or_chatty_reply(self):
        self.assertEqual(judge.parse('{"verdict": "fail", "reason": "x"}')["verdict"], "fail")
        self.assertEqual(judge.parse('Here:\n```json\n{"verdict": "pass", "reason": "ok"}\n```')["verdict"], "pass")
        for reply in (None, "", "pass", '{"verdict": "maybe"}'):
            with self.assertRaises(ValueError):
                judge.parse(reply)

    def test_the_configured_panel_reaches_each_judge_where_it_runs(self):
        _, panel = config.load()
        opus, gpt, kimi = panel.judges
        self.assertEqual(opus.provider, "anthropic")  # Claude Code, with the Claude models' credential
        self.assertEqual((gpt.base_url, gpt.api_key_env), ("https://api.openai.com/v1", "OPENAI_API_KEY"))
        self.assertEqual((kimi.base_url, kimi.api_key_env), (config.BASETEN_URL, "BASETEN_API_KEY"))
        self.assertIs(panel.chair, kimi)
        self.assertEqual(panel.only("GPT-6.1 Sol").judges, [gpt])
        with self.assertRaises(SystemExit):
            panel.only("gpt-x")

    def test_a_judge_model_the_provider_does_not_list_is_caught(self):
        listing = io.BytesIO(json.dumps({"data": [{"id": "other"}]}).encode())
        with mock_env(PR_EVAL_TEST_KEY="k"), mock.patch.object(config.urllib.request, "urlopen", return_value=listing):
            problem = Judge(model="m", base_url="http://x", api_key_env="PR_EVAL_TEST_KEY").problem()
        self.assertIn("can't use the judge model m", problem)

    def test_solved_needs_the_tests_and_the_judges(self):
        cases = [(True, {"verdict": "pass"}, ("solved", None)), (True, {"verdict": "fail"}, ("failed", None)),
                 (False, {"verdict": "pass"}, ("failed", None)), (True, {"error": "HTTP 500"}, ("invalid", "judge-error"))]
        for passed, verdict, expected in cases:
            with tempfile.TemporaryDirectory() as d, mock.patch.object(runner.judge_mod, "grade", return_value=dict(verdict)):
                _, outcome, reason = runner.judge_attempt(Panel([self.judge]), self.task, "diff", {"passed": passed}, "", Path(d))
                self.assertTrue((Path(d) / "judge.json").is_file())
            self.assertEqual((outcome, reason), expected, (passed, verdict))


class PanelTest(unittest.TestCase):
    panel = Panel([Judge(model="a", label="A"), Judge(model="b", label="B"), Judge(model="c", label="C")],
                  Judge(model="c", label="C"))

    def grade(self, votes: dict, chair: dict) -> tuple[dict, list[str]]:
        """The panel's record when each judge answers with `votes[model]` and the chair with `chair`."""
        asked = []

        def ask(j, system, user):
            asked.append(user)
            return dict(chair) if system == judge.CHAIR else dict(votes[j.model])
        with tempfile.TemporaryDirectory() as d, mock.patch.object(judge, "ask", side_effect=ask):
            return judge.grade(self.panel, judged_task(d), "diff", {"passed": True}, ""), asked

    def test_the_chair_reads_every_verdict_and_gives_the_final_one(self):
        votes = {"a": {"verdict": "pass", "reason": "fine"}, "b": {"verdict": "fail", "reason": "gamed"},
                 "c": {"verdict": "pass", "reason": "ok"}}
        graded, asked = self.grade(votes, {"verdict": "fail", "reason": "B is right: it hardcodes the value."})
        self.assertEqual((graded["verdict"], graded["reason"]), ("fail", "B is right: it hardcodes the value."))
        self.assertEqual([v["label"] for v in graded["panel"]], ["A", "B", "C"])
        self.assertEqual(graded["chair"]["label"], "C")
        self.assertIn("- B: fail. gamed", asked[-1])  # the chair sees the judges' reasons
        self.assertEqual(graded["model"], "a+b+c>c")

    def test_a_judge_that_fails_to_answer_leaves_the_rest_of_the_panel(self):
        votes = {"a": {"verdict": "pass", "reason": "fine"}, "b": {"error": "HTTP 503"}, "c": {"verdict": "pass", "reason": "ok"}}
        graded, asked = self.grade(votes, {"verdict": "pass", "reason": "Both judges that answered agree."})
        self.assertEqual(graded["verdict"], "pass")
        self.assertIn("- B: no verdict", asked[-1])
        votes["c"] = {"error": "HTTP 429"}
        graded, _ = self.grade(votes, {"verdict": "pass", "reason": "x"})
        self.assertIn("B: HTTP 503", graded["error"])  # one of three is not a panel

    def test_a_unanimous_panel_stands_when_the_chair_fails(self):
        votes = {k: {"verdict": "fail", "reason": "incomplete"} for k in "abc"}
        graded, _ = self.grade(votes, {"error": "HTTP 500"})
        self.assertEqual(graded["verdict"], "fail")
        votes["a"] = {"verdict": "pass", "reason": "fine"}
        graded, _ = self.grade(votes, {"error": "HTTP 500"})
        self.assertIn("chair", graded["error"])  # a split panel needs its chair

    def test_a_claude_judge_runs_claude_code_with_no_tools_and_only_its_credential(self):
        ran = {}

        def run(command, **kw):
            ran.update(command=command, **kw)
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(
                {"result": '{"verdict": "pass", "reason": "ok"}', "total_cost_usd": 0.02,
                 "usage": {"input_tokens": 5, "cache_read_input_tokens": 100, "output_tokens": 40}}))
        with mock_env(CLAUDE_CODE_OAUTH_TOKEN="tok", BASETEN_API_KEY="secret"), \
                mock.patch.object(judge.shutil, "which", return_value="/bin/claude"), \
                mock.patch.object(judge.subprocess, "run", side_effect=run):
            graded = judge.ask_claude(Judge(model="claude-x", provider="anthropic", effort="high"), "be fair", "the diff")
        command = ran["command"]
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertEqual(command[command.index("--effort") + 1], "high")
        self.assertEqual(command[command.index("--system-prompt") + 1], "be fair")
        self.assertEqual(ran["input"], "the diff")
        self.assertEqual(ran["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "tok")
        self.assertNotIn("BASETEN_API_KEY", ran["env"])  # no other key reaches it
        self.assertEqual(ran["env"]["HOME"], ran["cwd"])  # a throwaway home: no user settings, hooks or memory
        self.assertEqual((graded["verdict"], graded["input_tokens"], graded["cost_usd"]), ("pass", 105, 0.02))


if __name__ == "__main__":
    unittest.main()


class TraceTest(unittest.TestCase):
    def write(self, trial: Path, events: list[dict], seconds: float | None = 100) -> None:
        trial.mkdir(parents=True, exist_ok=True)
        (trial / "agent.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events) + "not json\n")
        if seconds:
            (trial / "result.json").write_text(json.dumps({"agent": {"seconds": seconds}}))

    @staticmethod
    def said(*blocks, parent=None):
        return {"type": "assistant", "parent_tool_use_id": parent, "message": {"content": list(blocks)}}

    @staticmethod
    def returned(tool_id, output, at, error=False):
        return {"type": "user", "timestamp": at, "message": {"content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": output, "is_error": error}]}}

    def test_steps_pair_each_call_with_its_result_and_time(self):
        with tempfile.TemporaryDirectory() as d:
            trial = Path(d) / "t"
            self.write(trial, [
                {"type": "system", "subtype": "init"}, {"type": "stream_event"},
                self.said({"type": "thinking", "thinking": "", "signature": "x"}),
                self.said({"type": "thinking", "thinking": "Look at the parser."},
                          {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "grep -rn parse .\nls"}}),
                self.returned("a", "p.go:1: parse", "2026-10-20T00:00:30Z"),
                self.said({"type": "tool_use", "id": "b", "name": "Edit", "input": {
                    "file_path": "/workspace/p.go", "old_string": "a - b", "new_string": "a + b"}}),
                self.returned("b", [{"type": "text", "text": "no such file"}], "2026-10-20T00:01:40Z", error=True),
                self.said({"type": "text", "text": "Done."}),
                {"type": "result", "subtype": "success", "num_turns": 3, "duration_ms": 100000},
            ])
            got = trace.condense(trial)
        kinds = [(s["kind"], s.get("tool")) for s in got["steps"]]
        self.assertEqual(kinds, [("thinking", None), ("tool", "Bash"), ("tool", "Edit"), ("text", None)])
        bash, edit = got["steps"][1], got["steps"][2]
        self.assertEqual((bash["title"], bash["detail"], bash["output"], bash["at"]), ("grep -rn parse .", "grep -rn parse .\nls", "p.go:1: parse", 30))
        self.assertEqual((edit["title"], edit["detail"], edit["error"], edit["at"]), ("p.go", "- a - b\n+ a + b", True, 100))
        self.assertEqual((got["hidden_thinking"], got["tool_calls"], got["tool_errors"], got["finished"]["turns"]), (1, 2, 1, 3))

    def test_credentials_never_leave_in_a_trace(self):
        with tempfile.TemporaryDirectory() as d, mock_env(SOME_SERVICE_TOKEN="plain-words-but-secret"):
            trial = Path(d) / "t"
            self.write(trial, [
                self.said({"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "env"}}),
                self.returned("a", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx\nX=plain-words-but-secret\n"
                                   "Authorization: Bearer abcdefghijklmnop12345\ntoken = read_token()", "2026-10-20T00:00:30Z"),
            ])
            text = json.dumps(trace.condense(trial))
        for secret in ("sk-proj-abc", "plain-words-but-secret", "abcdefghijklmnop12345"):
            self.assertNotIn(secret, text)
        self.assertIn("token = read_token()", text)  # code that only names a secret stays readable

    def test_long_outputs_keep_their_start_and_end(self):
        clipped = trace.clip("a" * 5000 + "END", 300)
        self.assertTrue(clipped.startswith("a" * 100) and clipped.endswith("END"))
        self.assertLess(len(clipped), 400)

    def test_a_hosted_page_reads_the_condensed_copy(self):
        with tempfile.TemporaryDirectory() as d:
            trial = Path(d)
            self.assertIsNone(trace.load(trial))
            (trial / "trace.json").write_text(json.dumps({"steps": [{"kind": "text", "text": "hi"}]}))
            self.assertEqual(trace.load(trial)["steps"][0]["text"], "hi")
