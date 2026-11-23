"""Working out a repository's install and test commands (eval_sandbox/commands.py): the first guess from its
files, the model loop against a fake model and sandbox, and the run step that keeps and uses what works."""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval_sandbox import commands, pipeline, runner, tasks  # noqa: E402
from eval_sandbox.commands import Proof  # noqa: E402


def files(tree: dict[str, object]):
    """guess()'s paths and reader for a tree of {path: text or JSON-able}."""
    texts = {p: v if isinstance(v, str) else json.dumps(v) for p, v in tree.items()}
    return list(texts), texts.get


class GuessTest(unittest.TestCase):
    def test_pnpm_and_vitest_at_the_root(self):
        paths, read = files({"package.json": {"packageManager": "pnpm@9.1.0+sha512.abc", "devDependencies": {"vitest": "^2"}},
                             "pnpm-lock.yaml": "", "src/a.test.ts": ""})
        got = commands.guess("TypeScript", paths, read, ["src/a.test.ts"])
        self.assertEqual(got["setup"], "pnpm install --frozen-lockfile")
        self.assertEqual(got["test"], f"{commands.BINS} && vitest run --coverage.enabled=false {{test_files}}")

    def test_npm_and_jest_from_the_test_script(self):
        paths, read = files({"package.json": {"scripts": {"test": "jest --silent"}, "devDependencies": {"mocha": "1"}},
                             "package-lock.json": "{}", "test/a.test.js": ""})
        got = commands.guess("JavaScript", paths, read, ["test/a.test.js"])
        self.assertEqual(got["setup"], "npm ci --no-audit --no-fund")
        self.assertIn("jest --ci --coverage=false --runTestsByPath {test_files}", got["test"])  # the script's runner wins

    def test_a_yarn_workspace_runs_the_tests_from_their_package(self):
        paths, read = files({"package.json": {"packageManager": "yarn@4.1.0", "workspaces": ["packages/*"]},
                             "yarn.lock": "", "packages/core/package.json": {"devDependencies": {"mocha": "10"}},
                             "packages/core/test/a.test.js": ""})
        got = commands.guess("JavaScript", paths, read, ["packages/core/test/a.test.js"])
        self.assertEqual(got["setup"], "yarn install --immutable")  # at the root, where the lockfile is
        self.assertIn("cd packages/core && " + commands.BINS + " && mocha ", got["test"])
        # From there, the files are named from the package's folder.
        test = got["test"].replace("{test_files}", "'packages/core/test/a.test.js'")
        out = subprocess.run(["bash", "-c", "echo " + test.split(" mocha ", 1)[1]], capture_output=True, text=True).stdout
        self.assertEqual(out.strip(), "test/a.test.js")

    def test_classic_yarn_and_node_test(self):
        paths, read = files({"package.json": {"scripts": {"test": "node --test test/"}}, "yarn.lock": "", "test/a.test.js": ""})
        got = commands.guess("JavaScript", paths, read, ["test/a.test.js"])
        self.assertEqual(got["setup"], "yarn install --frozen-lockfile")
        self.assertTrue(got["test"].endswith("node --test {test_files}"))

    def test_rust_installs_its_toolchain_under_home(self):
        paths, read = files({"Cargo.toml": "[package]", "tests/a.rs": ""})
        got = commands.guess("Rust", paths, read, ["tests/a.rs"])
        self.assertIn("sh.rustup.rs", got["setup"])
        self.assertIn("cargo test --no-run", got["setup"])
        self.assertTrue(got["test"].endswith("cargo test --offline"))

    def test_go_and_python_keep_their_defaults(self):
        for language in ("Go", "Python"):
            self.assertEqual(commands.guess(language, [], lambda p: None, []), tasks.recipe("", language, []))

    def test_nothing_fits(self):
        paths, read = files({"package.json": {"devDependencies": {"vitest": "1"}}, "bun.lockb": ""})
        self.assertIsNone(commands.guess("TypeScript", paths, read, []))  # bun: the model works it out
        paths, read = files({"package.json": {"scripts": {"test": "echo no tests"}}})
        self.assertIsNone(commands.guess("JavaScript", paths, read, []))
        self.assertIsNone(commands.guess("Java", ["pom.xml"], lambda p: None, []))

    def test_a_typescript_pr_is_exported_with_a_guess(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / "repo"
            (repo / "src").mkdir(parents=True)

            def git(*args):
                return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=repo,
                                      check=True, capture_output=True, text=True).stdout.strip()
            (repo / "package.json").write_text(json.dumps({"devDependencies": {"vitest": "1"}}))
            (repo / "package-lock.json").write_text("{}")
            (repo / "src" / "a.ts").write_text("export const a = 1\n")
            (repo / "src" / "a.test.ts").write_text("old\n")
            git("init", "-q", "-b", "main")
            git("add", "-A")
            git("commit", "-qm", "base")
            (repo / "src" / "a.ts").write_text("export const a = 2\n")
            (repo / "src" / "a.test.ts").write_text("new\n")
            git("commit", "-qam", "fix")
            pr = {"number": 4, "title": "Fix a", "body": "a should be 2, not 1. " * 5, "merge_commit_sha": git("rev-parse", "HEAD"),
                  "html_url": "https://github.com/o/r/pull/4", "merged_at": "2026-10-01T00:00:00Z"}
            with mock.patch.object(tasks, "gh", return_value=[]), \
                    mock.patch.object(tasks, "base_commit", return_value=git("rev-parse", "HEAD~1")):
                task = tasks.load(tasks.export_task(repo / ".git", "o/r", "TypeScript", pr, Path(d) / "tasks"))
        self.assertEqual(task.meta["environment"]["setup"], "npm ci --no-audit --no-fund")
        self.assertIn("vitest run --coverage.enabled=false {test_files}", task.meta["verifier"]["test_template"])
        self.assertTrue(task.meta["verifier"]["test"].endswith("vitest run --coverage.enabled=false src/a.test.ts"))
        with self.assertRaises(tasks.Skip):  # a repository's own commands still leave out what they can't run
            tasks.recipe("grafana/grafana", "TypeScript", ["public/app/a.test.tsx"])


class RanTestsTest(unittest.TestCase):
    def test_counts_and_words(self):
        ran = ["Test Files  1 passed (1)\n     Tests  3 passed (3)", "Tests:       2 passed, 2 total",
               "  4 passing (12ms)", "5 passed in 0.12s", "test result: ok. 0 passed\ntest result: ok. 3 passed",
               "ok  \tgithub.com/o/r/pkg\t0.01s", "# pass 2\n# fail 0", "something a runner said"]
        none = ["No test files found, exiting with code 0", "No tests found, exiting with code 0",
                "no tests ran in 0.01s", "running 0 tests\ntest result: ok. 0 passed", "Tests  0 passed (0)"]
        for out in ran:
            self.assertTrue(commands.ran_tests(out), out)
        for out in none:
            self.assertFalse(commands.ran_tests(out), out)


class LoopTest(unittest.TestCase):
    def model(self, *answers):
        replies = iter(answers)
        asked = []

        def ask(messages):
            asked.append([m["content"] for m in messages])
            answer = next(replies)
            return (answer if isinstance(answer, str) else json.dumps(answer)), 0.01
        return ask, asked

    def test_it_looks_then_tries_until_one_passes(self):
        ask, asked = self.model({"action": "read", "path": "package.json"}, "not json",
                                {"action": "run", "command": "ls"},
                                {"action": "try", "setup": "npm ci", "test": "npx vitest run {test_files}"},
                                {"action": "try", "setup": "npm ci", "test": "npx vitest run --root . {test_files}"})
        proofs = iter([Proof(False, "tests", "No test files found"), Proof(True, "", "1 passed")])
        proved = []

        def prove(setup, test):
            proved.append((setup, test))
            return next(proofs)
        got = commands.loop("context", ask=ask, run=lambda c: f"ran {c}", read=lambda p: f"read {p}", prove=prove)
        self.assertEqual((got["setup"], got["test"]), ("npm ci", "npx vitest run --root . {test_files}"))
        self.assertEqual(len(got["tried"]), 2)
        self.assertAlmostEqual(got["spent"], 0.05)
        self.assertEqual(len(proved), 2)
        said = asked[-1]
        self.assertIn("read package.json", said[3])
        self.assertIn("JSON object", said[5])  # a bad answer is told so, and the loop goes on
        self.assertIn("ran ls", said[7])
        self.assertIn("No test files found", said[9])  # the failed try's output goes back to the model

    def test_a_given_command_stays_in_every_try(self):
        ask, _ = self.model({"action": "try", "setup": "something else", "test": "jest {test_files}"})
        seen = []
        commands.loop("c", ask=ask, run=None, read=None, fixed={"setup": "make deps"},
                      prove=lambda s, t: (seen.append((s, t)), Proof(True, "", ""))[1])
        self.assertEqual(seen, [("make deps", "jest {test_files}")])

    def test_it_stops_on_give_up_on_its_tries_and_on_its_turns(self):
        ask, _ = self.model({"action": "give_up", "reason": "needs a database"})
        with self.assertRaisesRegex(commands.Unsolved, "needs a database"):
            commands.loop("c", ask=ask, run=None, read=None, prove=None)
        ask, _ = self.model(*[{"action": "try", "setup": "a", "test": "b"}] * 3)
        with self.assertRaises(commands.Unsolved) as caught:
            commands.loop("c", ask=ask, run=None, read=None, prove=lambda s, t: Proof(False, "setup", "boom"), tries=2)
        self.assertEqual(len(caught.exception.tried), 2)
        ask, _ = self.model(*[{"action": "read", "path": "x"}] * 3)
        with self.assertRaisesRegex(commands.Unsolved, "3 answers"):
            commands.loop("c", ask=ask, run=None, read=lambda p: "", prove=None, turns=3)


def make_task(root: Path, repo: str = "o/r", number: int = 1, setup: str = "npm ci",
              test: str = "jest {test_files}", lines: int = 10) -> tasks.Task:
    path = root / f"{repo.replace('/', '__')}-{number}"
    (path / "tests" / "files" / "src").mkdir(parents=True)
    (path / "tests" / "files" / "src" / "a.test.ts").write_text("test")
    (path / "validation").mkdir()
    (path / "validation" / "result.json").write_text("{}")
    (path / "instruction.md").write_text("# Fix\n")
    tasks.write_toml(path / "task.toml", {
        "task": {"id": path.name, "repo": repo, "pr_number": number, "title": "Fix", "language": "TypeScript",
                 "lines_changed": lines, "base_sha": "b", "reference_sha": "r"},
        "environment": {"setup": setup, "setup_timeout_sec": 900},
        "verifier": {"test": test.replace("{test_files}", "src/a.test.ts"), "test_template": test,
                     "test_files": ["src/a.test.ts", "README.md"], "timeout_sec": 900}})
    return tasks.load(path)


class SettleTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.saved = self.root / "commands.json"

    def tearDown(self):
        self.dir.cleanup()

    def settle(self, mine, **kwargs):
        status = []
        with contextlib.redirect_stdout(io.StringIO()):
            record, settled = commands.settle(self.root / "job", "o/r", mine, runner.Settings(), "run-1",
                                              saved_path=self.saved, status=status.append, **kwargs)
        return record, settled, status

    def test_a_guess_that_passes_is_kept_for_the_next_run(self):
        mine = [make_task(self.root, number=1, lines=50), make_task(self.root, number=2, lines=5)]
        with mock.patch.object(commands, "prove", return_value=Proof(True, "", "1 passed")) as prove:
            record, settled, status = self.settle(mine)
        self.assertEqual(prove.call_args.args[0].id, "o__r-2")  # proved on the smallest PR
        self.assertEqual((record["source"], record["setup"], record["tries"]), ("worked out", "npm ci", 1))
        self.assertEqual(settled, mine)  # the tasks already had these commands
        self.assertIn("Working out how to install and test o/r", status[0])
        self.assertEqual(commands.saved("O/R", self.saved)["test"], "jest {test_files}")
        with mock.patch.object(commands, "prove") as prove:  # the next run uses them as they are
            record, _, _ = self.settle(mine)
        prove.assert_not_called()
        self.assertEqual(record["source"], "saved")

    def test_when_the_guess_fails_the_model_works_them_out_and_the_tasks_follow(self):
        mine = [make_task(self.root)]
        answers = iter([{"action": "try", "setup": "pnpm install", "test": "vitest run {test_files}"}])
        proofs = iter([Proof(False, "setup", "npm ERR! missing lockfile"), Proof(True, "", "1 passed")])
        with mock.patch.object(commands, "prove", side_effect=lambda *a: next(proofs)), \
                mock.patch.object(commands, "Bench"):
            record, settled, _ = self.settle(mine, ask=lambda messages: (json.dumps(next(answers)), 0.02))
        self.assertEqual((record["source"], record["setup"], record["tries"], record["cost_usd"]),
                         ("worked out", "pnpm install", 2, 0.02))
        task = tasks.load(mine[0].path)  # the folder now runs them, and is checked again
        self.assertEqual(task.meta["environment"]["setup"], "pnpm install")
        self.assertEqual(task.meta["verifier"]["test"], "vitest run src/a.test.ts")
        self.assertIn("vitest run src/a.test.ts", (task.path / "tests" / "test.sh").read_text())
        self.assertFalse((task.path / "validation" / "result.json").exists())
        self.assertEqual(settled[0].meta["environment"]["setup"], "pnpm install")

    def test_when_nothing_works_the_run_stops_saying_what_was_tried(self):
        mine = [make_task(self.root)]
        with mock.patch.object(commands, "prove", return_value=Proof(False, "tests", "Error: Cannot find module 'x'")), \
                mock.patch.object(commands, "Bench"), self.assertRaises(SystemExit) as stopped:
            self.settle(mine, ask=lambda messages: (json.dumps({"action": "give_up", "reason": "needs a database"}), 0.0))
        said = str(stopped.exception.code)
        for part in ("o/r", "needs a database", "jest {test_files}", "Cannot find module", "--setup and --test"):
            self.assertIn(part, said)
        self.assertIsNone(commands.saved("o/r", self.saved))

    def test_given_and_curated_commands_are_never_worked_out(self):
        mine = [make_task(self.root)]
        with mock.patch.object(commands, "prove") as prove:
            record, _, _ = self.settle(mine, setup="npm ci", test="jest {test_files}")
            self.assertEqual(record["source"], "given")
            with mock.patch.object(commands, "curated", return_value=True):
                self.assertEqual(self.settle(mine)[0]["source"], "default")
        prove.assert_not_called()
        self.assertTrue(commands.curated("honojs/hono"))
        self.assertFalse(commands.curated("o/r"))


class RunStepTest(unittest.TestCase):
    def test_the_run_records_each_named_repositorys_commands(self):
        with tempfile.TemporaryDirectory() as d:
            job = pipeline.new_job(pipeline.Request(repos=["o/r"]), [], None, name="r1", jobs_dir=Path(d))
            mine = make_task(Path(d), "o/r")
            other = make_task(Path(d), "x/y")
            record = {"setup": "s", "test": "t", "source": "worked out"}
            with mock.patch.object(commands, "settle", return_value=(record, [mine])) as settle:
                self.assertEqual(pipeline.settle_commands(job, [mine, other], runner.Settings()), [mine, other])
                self.assertEqual(pipeline.Job(job.path).meta["commands"], {"o/r": record})
                pipeline.settle_commands(job, [mine], runner.Settings())  # resumed: not worked out again
            settle.assert_called_once()
            sample = pipeline.new_job(pipeline.Request(), [], None, name="r2", jobs_dir=Path(d))
            with mock.patch.object(commands, "settle") as settle:
                pipeline.settle_commands(sample, [other], runner.Settings())
            settle.assert_not_called()  # the samples carry their own

    def test_saved_commands_are_collected_with_and_forgotten_when_nothing_passes(self):
        with tempfile.TemporaryDirectory() as d:
            saved = Path(d) / "commands.json"
            commands.keep("o/r", {"setup": "npm ci", "test": "jest {test_files}"}, saved)
            with mock.patch.object(commands, "SAVED", saved), \
                    mock.patch.object(pipeline.tasks, "collect", return_value=[]) as collect:
                pipeline.find_tasks(pipeline.Request(repos=["o/r"]), Path(d))
                self.assertEqual((collect.call_args.kwargs["setup"], collect.call_args.kwargs["test"]),
                                 ("npm ci", "jest {test_files}"))
                pipeline.find_tasks(pipeline.Request(repos=["o/r"], setup="make"), Path(d))
                self.assertEqual(collect.call_args.kwargs["setup"], "make")  # given wins
            job = SimpleNamespace(meta={"commands": {"o/r": {"source": "saved"}}, "tasks": []}, path=Path(d),
                                  status=lambda *a, **k: None, save=lambda: None, id="r1")
            with mock.patch.object(commands, "SAVED", saved), mock.patch.object(runner, "check_and_run"), \
                    mock.patch.object(pipeline.report, "build"), self.assertRaises(SystemExit):
                pipeline.check_and_run(job, [], [], runner.Settings())
            self.assertIsNone(commands.saved("o/r", saved))


if __name__ == "__main__":
    unittest.main()
