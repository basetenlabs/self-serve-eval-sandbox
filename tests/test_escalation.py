"""Escalation runs: each task goes to the cheapest model first, and up the ladder only when it isn't solved.
Every trial here is a fake; nothing reaches a sandbox or a model."""
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

from eval_sandbox import app, cli, pipeline, report, runner
from eval_sandbox.config import Model


def model(key: str, output: float, input: float = 1.0) -> Model:
    return Model(key=key, label=key.title(), kind="open", provider="baseten", model=f"org/{key}", effort="high",
                 prices={f"org/{key}": {"input": input, "output": output}})


CHEAP, MID, DEAR = model("cheap", 0.5), model("mid", 4.4), model("dear", 20.0)
LADDER = [CHEAP, MID, DEAR]
KEYS = [m.key for m in LADDER]


def write_result(job_dir: Path, task_id: str, key: str, outcome: str, *, reason: str | None = None,
                 cost: float | None = 0.1, tried: int = 1, earlier: list[float] = ()) -> dict:
    result = {"trial": f"{task_id}__{key}__1", "task_id": task_id, "model": key, "attempt": 1, "outcome": outcome,
              "invalid_reason": reason, "try": tried, "agent": {"cost_usd": cost},
              "earlier_tries": [{"try": n + 1, "outcome": "failed", "agent": {"cost_usd": c}} for n, c in enumerate(earlier)],
              "started_at": "2026-11-20T10:00:00+00:00", "finished_at": "2026-11-20T10:01:00+00:00"}
    path = job_dir / "trials" / result["trial"]
    path.mkdir(parents=True, exist_ok=True)
    (path / "result.json").write_text(json.dumps(result))
    return result


def scripted(job_dir: Path, outcomes: dict[tuple[str, str], str], ran: list):
    """A fake run_trial: writes and returns each trial's scripted outcome, as the real one writes result.json."""
    lock = threading.Lock()

    def run_trial(task, m, attempt, path, *_):
        with lock:
            ran.append((task.id, m.key))
            tried = ran.count((task.id, m.key))  # a failed try is followed by the next, up to the run's tries
        outcome = outcomes.get((task.id, m.key), "failed")
        reason = "provider-error" if outcome == "lost" else "no-patch" if outcome == "invalid" else None
        return write_result(job_dir, task.id, m.key, "invalid" if reason else outcome, reason=reason, tried=tried)
    return run_trial


class Ladder(unittest.TestCase):
    def test_without_figures_the_cheapest_output_price_goes_first(self):
        order, shown = pipeline.ladder([DEAR, CHEAP, MID], {})
        self.assertEqual([m.key for m in order], KEYS)
        self.assertEqual(shown, {"dear": None, "cheap": None, "mid": None})
        twin = model("twin", 0.5, input=0.1)  # the same output price: the input price decides
        self.assertEqual([m.key for m in pipeline.ladder([CHEAP, twin], {})[0]], ["twin", "cheap"])

    def test_measured_cost_per_attempt_beats_token_prices(self):
        # The cheap one by price is the dearest per attempt: it takes far more turns.
        found = {"cheap": {"cost_per_attempt": 3.0, "by_scope": {}}, "mid": {"cost_per_attempt": 0.4, "by_scope": {}},
                 "dear": {"cost_per_attempt": 1.0, "by_scope": {}}}
        order, shown = pipeline.ladder(LADDER, found)
        self.assertEqual([m.key for m in order], ["mid", "dear", "cheap"])
        self.assertEqual(shown["cheap"], 3.0)

    def test_figures_for_these_repositories_come_first_and_are_never_mixed(self):
        found = {"cheap": {"cost_per_attempt": 0.1, "by_scope": {"o/big": {"cost_per_attempt": 5.0}}},
                 "mid": {"cost_per_attempt": 0.2, "by_scope": {"o/big": {"cost_per_attempt": 2.0}}},
                 "dear": {"cost_per_attempt": 0.3, "by_scope": {}}}
        # Not every model has a figure for o/big: the figures over every run order them.
        order, shown = pipeline.ladder(LADDER, found, "o/big")
        self.assertEqual([m.key for m in order], KEYS)
        self.assertEqual(shown, {"cheap": 5.0, "mid": 2.0, "dear": 0.3})  # as the page shows them for o/big
        found["dear"]["by_scope"]["o/big"] = {"cost_per_attempt": 9.0}
        self.assertEqual([m.key for m in pipeline.ladder(LADDER, found, "o/big")[0]], ["mid", "cheap", "dear"])
        del found["dear"]  # one model without any figure: token prices for all
        self.assertEqual([m.key for m in pipeline.ladder(LADDER, found, "o/big")[0]], KEYS)

    def test_the_plan_reads_past_runs_like_the_page(self):
        with tempfile.TemporaryDirectory() as d:
            jobs = Path(d)
            past = jobs / "past"
            past.mkdir()
            (past / "run.json").write_text(json.dumps({"created_at": "2026-11-01T00:00:00+00:00", "tasks": ["o__r-1"]}))
            summary = {k: {"valid": 2, "solved": 2, "tries": 2, "cost_per_attempt": c, "cost_per_try": c}
                       for k, c in (("cheap", 2.0), ("mid", 0.5), ("dear", 1.0))}
            (past / "report.json").write_text(json.dumps({"summary": summary}))
            with mock.patch.object(pipeline.config, "load", return_value=({}, None)):
                plan = pipeline.escalation_plan([CHEAP, MID, DEAR], pipeline.Request(repos=["O/R"]), jobs)
        self.assertEqual(plan["ladder"], ["mid", "dear", "cheap"])
        self.assertEqual(plan["cost_per_attempt"], {"cheap": 2.0, "mid": 0.5, "dear": 1.0})  # every try solved: one each

    def test_a_new_escalation_run_records_its_ladder_and_one_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            plan = {"ladder": KEYS, "cost_per_attempt": dict.fromkeys(KEYS)}
            job = pipeline.new_job(pipeline.Request(task_ids=["o__r-1"]), [DEAR, CHEAP, MID], None, attempts=3,
                                   name="e", jobs_dir=Path(d), escalation=plan)
            plain = pipeline.new_job(pipeline.Request(task_ids=["o__r-1"]), [DEAR, CHEAP], None, name="p", jobs_dir=Path(d))
        self.assertEqual(job.meta["escalation"], plan)
        self.assertEqual(([m["key"] for m in job.meta["models"]], job.meta["attempts"]), (KEYS, 1))
        self.assertNotIn("escalation", plain.meta)
        self.assertEqual(pipeline.rungs(job.meta, [DEAR, MID, CHEAP]), LADDER)
        self.assertIsNone(pipeline.rungs(plain.meta, [DEAR, CHEAP]))
        self.assertIn("on the cheapest model first (Cheap, then Mid, then Dear)",
                      pipeline.plan_line({**job.meta, "tasks": ["o__r-1"]}, LADDER))


class Step(unittest.TestCase):
    def step(self, tries: int = 1, **results):
        return runner.escalation_step(KEYS, {k: v for k, v in results.items()}, tries)

    def test_the_next_model_up_takes_only_what_the_ones_below_did_not_solve(self):
        failed, solved = {"outcome": "failed"}, {"outcome": "solved"}
        self.assertEqual(self.step(), "cheap")
        self.assertIsNone(self.step(cheap=solved))
        self.assertEqual(self.step(cheap=failed), "mid")
        self.assertEqual(self.step(cheap={"outcome": "invalid", "invalid_reason": "no-patch"}), "mid")  # not scored
        self.assertEqual(self.step(cheap={"outcome": "invalid", "invalid_reason": "sandbox-error"}), "mid")
        self.assertIsNone(self.step(cheap=failed, mid=solved))
        self.assertIsNone(self.step(cheap=failed, mid=failed, dear=failed))  # unsolved after every model

    def test_a_rung_left_unfinished_carries_on(self):
        failed = {"outcome": "failed"}
        self.assertEqual(self.step(2, cheap={"outcome": "failed", "try": 1}), "cheap")  # stopped between its tries
        self.assertEqual(self.step(2, cheap={"outcome": "failed", "try": 2}), "mid")
        # The last model's attempt lost to infrastructure runs again, as a lost attempt does on any run.
        self.assertEqual(self.step(cheap=failed, mid=failed, dear={"outcome": "invalid", "invalid_reason": "provider-error"}), "dear")
        self.assertIsNone(self.step(cheap=failed, mid=failed, dear={"outcome": "invalid", "invalid_reason": "no-patch"}))


class Scheduling(unittest.TestCase):
    OUTCOMES = {("a", "cheap"): "solved",
                ("b", "cheap"): "failed", ("b", "mid"): "solved",
                ("c", "cheap"): "invalid", ("c", "mid"): "lost", ("c", "dear"): "solved",
                ("d", "cheap"): "failed", ("d", "mid"): "failed", ("d", "dear"): "failed"}

    def test_a_task_climbs_only_as_far_as_it_has_to(self):
        ran, progress = [], []
        candidates = [SimpleNamespace(id=t) for t in "abcd"]
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(runner, "needs_check", side_effect=lambda t, _: t.id in ("a", "c")), \
                mock.patch.object(runner, "validation_status", return_value="valid"), \
                mock.patch.object(runner, "validate_task", side_effect=lambda t, *_: {"task_id": t.id, "status": "valid"}), \
                mock.patch.object(runner, "prepare_trial", return_value=None), \
                mock.patch.object(runner, "run_trial", side_effect=scripted(Path(d), self.OUTCOMES, ran)), \
                contextlib.redirect_stdout(io.StringIO()):
            runner.check_and_run(candidates, LADDER, 1, Path(d), runner.Settings(concurrency=3), "r",
                                 on_result=lambda result, done, total: progress.append((done, total)), ladder=LADDER)
            lost = runner.lost_rungs(["a", "b", "c", "d"], LADDER, Path(d))
        by_task = {t: [k for task, k in ran if task == t] for t in "abcd"}
        self.assertEqual(by_task, {"a": ["cheap"], "b": ["cheap", "mid"], "c": ["cheap", "mid", "dear"],
                                   "d": ["cheap", "mid", "dear"]})
        self.assertEqual(progress[-1], (9, 9))  # every count ends where it started from: no cell waits forever
        self.assertTrue(all(done <= total for done, total in progress))
        self.assertEqual(lost, 0)

    def test_a_resume_picks_each_task_up_where_its_ladder_stopped(self):
        with tempfile.TemporaryDirectory() as d:
            job_dir = Path(d)
            write_result(job_dir, "a", "cheap", "failed", tried=2)  # stopped before mid
            write_result(job_dir, "b", "cheap", "solved")  # done
            # c: nothing yet
            for k in ("cheap", "mid"):
                write_result(job_dir, "d", k, "failed")
            write_result(job_dir, "d", "dear", "invalid", reason="sandbox-error")  # lost on the last model
            write_result(job_dir, "e", "cheap", "failed", tried=1)  # stopped between its tries
            write_result(job_dir, "f", "cheap", "solved")
            write_result(job_dir, "f", "mid", "failed")  # a later rung's leftover never reruns a solved task
            tasks = [SimpleNamespace(id=t) for t in "abcdef"]
            pending = runner.pending_trials(tasks, LADDER, 1, job_dir, tries=2, ladder=LADDER)
            self.assertEqual([(t.id, m.key, attempt) for t, m, attempt, _ in pending],
                             [("a", "mid", 1), ("c", "cheap", 1), ("d", "dear", 1), ("e", "cheap", 1)])
            self.assertEqual(runner.lost_rungs(["a", "b", "d"], LADDER, job_dir, tries=2), 2)  # a hasn't finished
            ran = []
            outcomes = {("a", "mid"): "failed", ("a", "dear"): "solved", ("c", "cheap"): "solved",
                        ("d", "dear"): "failed", ("e", "cheap"): "failed", ("e", "mid"): "solved"}
            with mock.patch.object(runner, "run_trial", side_effect=scripted(job_dir, outcomes, ran)), \
                    contextlib.redirect_stdout(io.StringIO()):
                runner.run(tasks, LADDER, 1, job_dir, runner.Settings(concurrency=2), "r", tries=2, ladder=LADDER)
            self.assertEqual(sorted(set(ran)), sorted([("a", "mid"), ("a", "dear"), ("c", "cheap"), ("d", "dear"),
                                                       ("e", "cheap"), ("e", "mid")]))
            self.assertEqual(ran.count(("a", "mid")), 2)  # failed on both its tries, then up to dear
            self.assertEqual(runner.pending_trials(tasks, LADDER, 1, job_dir, tries=2, ladder=LADDER), [])

    def test_a_stop_climbs_no_further(self):
        with tempfile.TemporaryDirectory() as d:
            job = (SimpleNamespace(id="a"), CHEAP, 1, Path(d))
            self.assertEqual(len(runner.climb(job, {"outcome": "failed"}, LADDER, Path(d))), 1)
            self.assertEqual(runner.climb(job, {"outcome": "solved"}, LADDER, Path(d)), [])
            self.assertEqual(runner.climb(job, {"outcome": "interrupted"}, LADDER, Path(d)), [])
            self.assertEqual(runner.climb((job[0], DEAR, 1, Path(d)), {"outcome": "failed"}, LADDER, Path(d)), [])
            with mock.patch.object(runner, "STOPPING", threading.Event()) as stopping:
                stopping.set()
                self.assertEqual(runner.climb(job, {"outcome": "failed"}, LADDER, Path(d)), [])


def escalation_run(d: str, plan_costs: dict | None = None, phase: str = "done") -> Path:
    """A finished escalation run on disk: a solved by cheap, b by mid, c unsolved after every model, and d solved
    by cheap after a try it failed."""
    job_dir = Path(d) / "jobs" / "esc"
    (Path(d) / "tasks").mkdir(parents=True, exist_ok=True)
    job_dir.mkdir(parents=True)
    (job_dir / "run.json").write_text(json.dumps({
        "run_id": "esc", "created_at": "2026-11-20T09:59:00+00:00", "request": {"task_ids": ["a", "b", "c", "d"]},
        "models": [m.as_dict() for m in LADDER], "attempts": 1, "tries": 2, "tasks": ["a", "b", "c", "d"],
        "candidates": ["a", "b", "c", "d"], "tasks_dir": str(Path(d) / "tasks"), "backend": "baseten", "image": "i",
        "escalation": {"ladder": KEYS, "cost_per_attempt": plan_costs or dict.fromkeys(KEYS)},
        "status": {"phase": phase, "pid": os.getpid()}}))
    write_result(job_dir, "a", "cheap", "solved", cost=0.1)
    write_result(job_dir, "b", "cheap", "failed", cost=0.2, tried=2, earlier=[0.1])
    write_result(job_dir, "b", "mid", "solved", cost=1.0)
    write_result(job_dir, "c", "cheap", "invalid", reason="no-patch", cost=0.05)
    write_result(job_dir, "c", "mid", "failed", cost=1.0, tried=2, earlier=[1.0])
    write_result(job_dir, "c", "dear", "failed", cost=4.0, tried=2, earlier=[4.0])
    write_result(job_dir, "d", "cheap", "solved", cost=0.1, tried=2, earlier=[0.1])
    return job_dir


class Report(unittest.TestCase):
    def test_who_solved_what_and_what_every_model_would_have_cost(self):
        with tempfile.TemporaryDirectory() as d:
            data = report.build_data(escalation_run(d))
        e = data["escalation"]
        self.assertEqual(e["ladder"], KEYS)
        self.assertEqual({t["task_id"]: t["solved_by"] for t in e["tasks"]}, {"a": "cheap", "b": "mid", "c": None, "d": "cheap"})
        self.assertEqual([s["model"] for s in e["tasks"][2]["steps"]], KEYS)
        self.assertEqual(e["tasks"][2]["steps"][0], {"model": "cheap", "outcome": "invalid", "invalid_reason": "no-patch"})
        self.assertEqual((e["solved_by"], e["tried"]), ({"cheap": 2, "mid": 1, "dear": 0}, {"cheap": 4, "mid": 2, "dear": 1}))
        self.assertEqual((e["unsolved"], e["remaining"], data["complete"]), (1, 0, True))
        # Every try of every attempt that ran, the one not scored too.
        spent = 0.1 + (0.1 + 0.2) + 1.0 + 0.05 + (1.0 + 1.0) + (4.0 + 4.0) + (0.1 + 0.1)
        self.assertAlmostEqual(e["cost_usd"], spent)
        # Not run: mid on a and d, dear on a, b and d; each at its mean cost per attempt in this run.
        mid_each, dear_each = data["summary"]["mid"]["cost_per_attempt"], data["summary"]["dear"]["cost_per_attempt"]
        self.assertAlmostEqual(mid_each, (1.0 + 2.0) / 2)
        self.assertAlmostEqual(dear_each, 8.0)
        every = e["every_model"]
        self.assertEqual(every["estimates"]["cheap"], {"attempts": 0, "cost_per_attempt": None, "source": None})
        self.assertEqual(every["estimates"]["dear"], {"attempts": 3, "cost_per_attempt": dear_each, "source": "this run"})
        self.assertEqual(every["estimated_attempts"], 5)
        self.assertAlmostEqual(every["estimated_usd"], 2 * mid_each + 3 * dear_each)
        self.assertAlmostEqual(every["cost_usd"], spent + 2 * mid_each + 3 * dear_each)
        self.assertAlmostEqual(e["saving"], 1 - spent / every["cost_usd"])

    def test_a_model_the_run_never_reached_takes_the_pages_estimate(self):
        with tempfile.TemporaryDirectory() as d:
            job_dir = escalation_run(d, {"cheap": 0.1, "mid": 1.0, "dear": 6.0})
            for name in ("c__mid__1", "c__dear__1", "b__mid__1"):
                (job_dir / "trials" / name / "result.json").unlink()
            write_result(job_dir, "b", "cheap", "solved", cost=0.2)
            write_result(job_dir, "c", "cheap", "solved", cost=0.1)
            e = report.build_data(job_dir)["escalation"]
            self.assertEqual(e["every_model"]["estimates"]["dear"], {"attempts": 4, "cost_per_attempt": 6.0, "source": "earlier runs"})
            json_ = json.loads((job_dir / "run.json").read_text())
            json_["escalation"]["cost_per_attempt"] = dict.fromkeys(KEYS)  # the page had no figure: token prices
            (job_dir / "run.json").write_text(json.dumps(json_))
            e = report.build_data(job_dir)["escalation"]
        cheap_each = (0.1 + 0.2 + 0.1 + 0.2) / 4
        self.assertEqual(e["every_model"]["estimates"]["mid"]["source"], "prices")
        self.assertAlmostEqual(e["every_model"]["estimates"]["mid"]["cost_per_attempt"], cheap_each * 4.4 / 0.5)

    def test_an_unfinished_run_shows_no_saving_and_a_plain_run_no_escalation(self):
        with tempfile.TemporaryDirectory() as d:
            job_dir = escalation_run(d)
            (job_dir / "trials" / "c__dear__1" / "result.json").unlink()
            data = report.build_data(job_dir)
            self.assertEqual((data["escalation"]["remaining"], data["complete"], data["escalation"]["saving"]), (1, False, None))
            meta = json.loads((job_dir / "run.json").read_text())
            del meta["escalation"]
            (job_dir / "run.json").write_text(json.dumps(meta))
            self.assertNotIn("escalation", report.build_data(job_dir))


class Page(unittest.TestCase):
    def test_the_board_waits_for_cheaper_models_and_skips_what_is_solved(self):
        with tempfile.TemporaryDirectory() as d:
            job_dir = escalation_run(d, phase="running")
            (job_dir / "trials" / "c__dear__1" / "result.json").unlink()
            (job_dir / "trials" / "c__dear__1" / "stage.json").write_text(json.dumps({"stage": "agent", "at": "x"}))
            meta = json.loads((job_dir / "run.json").read_text())
            meta["tasks"] += ["e"]
            meta["candidates"] += ["e", "f"]  # e passed its check and waits for cheap; f is still being checked
            (job_dir / "run.json").write_text(json.dumps(meta))
            page = app.App(job_dir.parent)
            with mock.patch.object(app, "alive", return_value=True):
                run = page.describe(job_dir)
                board = page.board(run)
                (job_dir / "run.json").write_text(json.dumps({**meta, "status": {"phase": "stopped"}}))
                stopped = page.board(page.describe(job_dir))
        stages = {r["id"]: [c["stage"] for c in r["cells"]] for r in board["rows"]}
        self.assertEqual(stages, {"a": ["solved", "not-needed", "not-needed"], "b": ["failed", "solved", "not-needed"],
                                  "c": ["invalid", "failed", "agent"], "d": ["solved", "not-needed", "not-needed"],
                                  "e": ["queued", "cheaper", "cheaper"], "f": ["waiting", "cheaper", "cheaper"]})
        self.assertEqual(run["ladder"], KEYS)
        # Done: the six results. Still to come: c's dear, and all three of e's at most.
        self.assertEqual(run["progress"], {"done": 6, "total": 6 + 1 + 3})
        self.assertEqual({r["id"]: [c["stage"] for c in r["cells"]] for r in stopped["rows"]}["e"],
                         ["not-run", "not-run", "not-run"])

    def test_only_a_lost_attempt_on_the_last_model_makes_a_finished_run_resumable(self):
        with tempfile.TemporaryDirectory() as d:
            job_dir = escalation_run(d)
            write_result(job_dir, "b", "cheap", "invalid", reason="sandbox-error")  # mid made up for it
            page = app.App(job_dir.parent)
            self.assertEqual((page.describe(job_dir)["lost"], page.describe(job_dir)["resumable"]), (0, False))
            write_result(job_dir, "c", "dear", "invalid", reason="provider-error")
            run = page.describe(job_dir)
        self.assertEqual((run["lost"], run["resumable"], run["progress"]), (1, True, {"done": 7, "total": 7}))

    def test_run_again_brings_back_the_switch(self):
        meta = {"request": {"quick": True}, "models": [{"key": "cheap"}, {"key": "mid"}]}
        self.assertEqual(app.again({**meta, "escalation": {"ladder": ["cheap", "mid"]}}),
                         {"quick": True, "models": ["cheap", "mid"], "judges": False, "escalate": True})
        self.assertNotIn("escalate", app.again(meta))

    def test_the_page_starts_an_escalation_run_with_two_models_or_more(self):
        def start(form: dict) -> dict:
            with tempfile.TemporaryDirectory() as d:
                page = app.App(Path(d))
                state = {"busy": False, "runs": [], "checks": {"sandboxes": True, "gh": True}, "judges": {"on": False}}
                with mock.patch.object(page, "state", return_value=state), \
                        mock.patch.object(page, "spawn") as spawn, mock.patch.object(app.pipeline, "preflight"), \
                        mock.patch.object(page, "repo_info", return_value={"repo": "o/a", "defaults": True}):
                    answer = page.start({"pulls": {"o/a": [1]}, **form})
                return {**answer, "argv": spawn.call_args.args[1] if spawn.called else None}
        self.assertIn("--escalate", start({"models": ["a", "b"], "escalate": True})["argv"])
        self.assertNotIn("--escalate", start({"models": ["a", "b"]})["argv"])  # off by default
        self.assertEqual(start({"models": ["a"], "escalate": True})["error"], pipeline.ESCALATE_NEEDS)


class Cli(unittest.TestCase):
    def test_run_escalate_records_the_ladder_and_a_resume_keeps_it(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(pipeline, "preflight", return_value=([DEAR, CHEAP, MID], None)), \
                mock.patch.object(pipeline, "execute", return_value=0) as execute, \
                mock.patch.object(pipeline, "sweep_private"), mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            jobs = Path(d) / "jobs"
            cli.main(["run", "o/r", "--escalate", "--models", "dear,cheap,mid", "--jobs", str(jobs), "--name", "e"])
            meta = pipeline.Job(jobs / "e").meta
            self.assertEqual((meta["escalation"]["ladder"], [m["key"] for m in meta["models"]]), (KEYS, KEYS))
            cli.main(["run", "--resume", str(jobs / "e")])
            self.assertEqual(pipeline.Job(jobs / "e").meta["escalation"]["ladder"], KEYS)
            self.assertEqual(execute.call_count, 2)
            with self.assertRaisesRegex(SystemExit, "keeps its models"):
                cli.main(["run", "--resume", str(jobs / "e"), "--attempts", "2"])
            with mock.patch.object(pipeline, "preflight", return_value=([CHEAP], None)), \
                    self.assertRaisesRegex(SystemExit, "at least two models"):
                cli.main(["run", "o/r", "--escalate", "--models", "cheap", "--jobs", str(jobs), "--name", "one"])


if __name__ == "__main__":
    unittest.main()
