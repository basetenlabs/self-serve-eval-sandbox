"""One-page report for a finished run: report.json plus a self-contained report.html.

Definitions:
- An attempt is *valid* unless setup, the harness, the provider or the verifier broke
  (or, in a run from before the judges only reviewed, the judges). Invalid attempts are
  reported separately and never count as failures.
- *Solved* means the PR's hidden tests passed. On a run with judges, their verdict and the
  problems they found are a review shown beside that, never part of it. A run recorded
  before then (its judge has no "review") needed the judges' pass too.
- *Solve rate* (pass@1) is solved attempts / valid attempts.
- *Solved at least once* (pass@k) counts tasks with at least one solved attempt.
- *Cost per solved task* is everything spent on valid attempts / solved attempts, so a
  model that fails often pays for its failures.
- An attempt may take several *tries* (run.json's `tries`, the same for every model): a try the
  model fails is run again from scratch, and the attempt is solved if any try solves it. Its cost
  and time are those of every try, so a solve on a later try pays for the tries before it.
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .causes import sentence
from .config import Model, redact_known
from .runner import ANSI, escalation_step, tries_left
from .tasks import DEFAULT_TASKS
from .tasks import load as load_task

TEMPLATE = Path(__file__).with_name("report_template.html")
MAX_PATCH_CHARS = 40_000


# The most of a log's end a report or the page reads: enough for its last lines, never the whole file.
TAIL_BYTES = 64 << 10


def read(path: Path, limit: int = MAX_PATCH_CHARS) -> str | None:
    """The file's first `limit` characters (only those are read), saying how much more there is."""
    if not path.is_file():
        return None
    with path.open(errors="replace") as file:
        text = file.read(limit)
    size = path.stat().st_size
    return text if size <= len(text.encode()) else text + f"\n... [about {size - len(text.encode())} more bytes in {path.name}]"


def tail(path: Path, lines: int = 60) -> str | None:
    """The file's last lines, read from its end only."""
    if not path.is_file():
        return None
    with path.open("rb") as file:
        file.seek(max(file.seek(0, 2) - TAIL_BYTES, 0))
        text = file.read().decode(errors="replace")
    return "\n".join(ANSI.sub("", text).splitlines()[-lines:])


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def busy_seconds(spans: list[tuple[datetime, datetime]]) -> float:
    """How long at least one span was going: overlaps count once, gaps between them not at all."""
    total, reach = 0.0, None
    for start, finish in sorted(spans):
        if reach is None or start > reach:
            total += (finish - start).total_seconds()
            reach = finish
        elif finish > reach:
            total += (finish - reach).total_seconds()
            reach = finish
    return total


def tries_of(t: dict) -> list[dict]:
    """Each try of an attempt, oldest first: the ones its model failed before (earlier_tries), then the last.
    An attempt from before tries were recorded is its one try."""
    return [*(t.get("earlier_tries") or []), t]


def working(agent: dict) -> float | None:
    """Agent time without the waits on provider rate limits (see trial_record)."""
    return agent.get("working_seconds", agent.get("seconds"))


def per_attempt(t: dict, value) -> float | None:
    """`value(agent)` added up over an attempt's tries; None when no try has it."""
    known = [v for v in (value(x.get("agent") or {}) for x in tries_of(t)) if v is not None]
    return sum(known) if known else None


def summarize_timing(trials: list[dict], started_at: str | None = None) -> dict:
    """Elapsed is wall clock while attempts ran, plus the setup before the first one.

    Parallel attempts count once, and a stopped run's idle time before it was resumed
    not at all. Summed agent time can overlap across trials. An attempt's tries each count.
    """
    tries = [x for t in trials for x in tries_of(t)]
    spans = [(datetime.fromisoformat(x["started_at"]), datetime.fromisoformat(x["finished_at"]))
             for x in tries if x.get("started_at") and x.get("finished_at")]
    first = min((s for s, _ in spans), default=None)
    start = datetime.fromisoformat(started_at) if started_at else first
    finish = max((f for _, f in spans), default=None)
    complete = len(spans) == len(tries)
    lead = max(0.0, (first - start).total_seconds()) if first and start else 0.0
    known = [seconds for x in tries if (seconds := working(x.get("agent") or {})) is not None]
    return {
        "started_at": start.isoformat() if start else None,
        "finished_at": finish.isoformat() if finish else None,
        "elapsed_seconds": lead + busy_seconds(spans) if complete and spans else None,
        "total_working_seconds": sum(known) if known else None,
        "timed_attempts": sum(all(working(x.get("agent") or {}) is not None for x in tries_of(t)) for t in trials),
        "attempts": len(trials),
    }


def summarize(trials: list[dict]) -> dict:
    valid = [t for t in trials if t["outcome"] in ("solved", "failed")]
    solved = [t for t in valid if t["outcome"] == "solved"]
    every_try = [x for t in valid for x in tries_of(t)]
    agent = [(x.get("agent") or {}) for x in every_try]  # each try's, failed tries included
    cost = sum(a.get("cost_usd") or 0 for a in agent)
    priced = all(a.get("cost_usd") is not None for a in agent)
    by_task = defaultdict(list)
    for t in valid:
        by_task[t["task_id"]].append(t)
    tokens = [{k: per_attempt(t, lambda a, k=k: (a.get("tokens") or {}).get(k)) or 0
               for k in ("input", "cached_input", "cache_write", "output")} for t in valid]
    solved_on = [sum((t.get("try") or 1) == n for t in solved) for n in range(1, max((t.get("try") or 1 for t in solved), default=0) + 1)]
    return {
        "attempts": len(trials), "valid": len(valid), "invalid": len(trials) - len(valid),
        "timing": summarize_timing(trials),
        "solved": len(solved),
        "pass_at_1": len(solved) / len(valid) if valid else None,
        "tasks": len(by_task),
        "tasks_solved": sum(any(t["outcome"] == "solved" for t in ts) for ts in by_task.values()),
        "cost_usd": cost if priced else None,
        "cost_per_attempt": cost / len(valid) if valid and priced else None,
        "cost_per_solved": cost / len(solved) if solved and priced else None,
        # Per try, for estimating runs with another number of tries (app.estimates).
        "tries": len(every_try),
        "cost_per_try": cost / len(every_try) if every_try and priced else None,
        "median_seconds_per_try": median(working(a) for a in agent),
        # How many solved attempts each try solved: [on try 1, on try 2, ...].
        "solved_on": solved_on,
        "median_seconds": median(per_attempt(t, working) for t in valid),
        "median_seconds_with_waits": median(per_attempt(t, lambda a: a.get("seconds")) for t in valid),
        "rate_limited_attempts": sum(1 for t in valid if per_attempt(t, lambda a: a.get("rate_limited_retries"))),
        "median_turns": median(per_attempt(t, lambda a: a.get("num_turns")) for t in valid),
        "mean_output_tokens": statistics.mean(t["output"] for t in tokens) if tokens else None,
        "mean_input_tokens": statistics.mean(t["input"] + t["cached_input"] + t["cache_write"]
                                             for t in tokens) if tokens else None,
        "agent_timeouts": sum(1 for a in agent if a.get("timed_out")),
        # Attempts stopped at the time limit: cost rebuilt from the log; "partial" ones
        # are missing some output tokens, so the total is a slight undercount.
        "rebuilt_cost_attempts": sum(1 for a in agent if str(a.get("cost_source")).startswith("rebuilt")),
        "partial_cost_attempts": sum(1 for a in agent if a.get("cost_source") == "rebuilt-partial"),
        "judge_disagreements": sum(1 for x in every_try if (x.get("tests") or {}).get("passed")
                                   and (x.get("judge") or {}).get("verdict") == "fail"),
    }


def trial_record(trial_dir: Path) -> dict | None:
    path = trial_dir / "result.json"
    if not path.is_file():
        return None
    r = json.loads(path.read_text())
    agent = with_working(r.get("agent") or {})
    earlier = [{**x, "agent": with_working(dict(x.get("agent") or {}))} for x in r.get("earlier_tries") or []]
    return {
        "trial": r["trial"], "task_id": r["task_id"], "model": r["model"], "attempt": r["attempt"],
        **({"try": r.get("try") or 1, "earlier_tries": earlier} if earlier or (r.get("try") or 1) > 1 else {}),
        "outcome": r["outcome"], "invalid_reason": r.get("invalid_reason"),
        "started_at": r.get("started_at"), "finished_at": r.get("finished_at"),
        "agent": {k: agent.get(k) for k in ("seconds", "working_seconds", "api_retries", "rate_limited_retries",
                                            "retry_wait_seconds", "timed_out", "num_turns", "tool_calls", "tokens",
                                            "cost_usd", "cost_source", "claude_code_cost_usd", "subtype",
                                            "is_error", "final_message")} if agent else None,
        "diff": r.get("diff"), "tests": r.get("tests"), "judge": r.get("judge"), "setup": r.get("setup"),
        "patch": read(trial_dir / "agent.patch"),
        "verifier_tail": tail(trial_dir / "verifier.log", 40),
        # Not scored: why, in a sentence, and the end of the log that shows it.
        "step": r.get("step"), "cause": sentence(r),
        "log": tail(trial_dir / r["log"], 80) if r.get("log") and ".." not in r["log"] else None,
    }


def with_working(agent: dict) -> dict:
    if agent.get("seconds") is not None:  # time spent backing off from rate limits is the provider's, not the model's
        agent["working_seconds"] = max(agent["seconds"] - (agent.get("retry_wait_seconds") or 0), 0)
    return agent


def build_data(job_dir: Path) -> dict:
    job_dir = job_dir.resolve()
    meta = json.loads((job_dir / "run.json").read_text())
    models = meta["models"]
    trial_dirs = sorted((job_dir / "trials").iterdir()) if (job_dir / "trials").is_dir() else []
    trials = [r for d in trial_dirs if d.is_dir() and (r := trial_record(d))]
    model_keys = [m["key"] for m in models]

    tasks_dir = Path(meta.get("tasks_dir") or DEFAULT_TASKS)
    if not tasks_dir.is_dir():  # a run copied from another machine: use this checkout's tasks
        tasks_dir = DEFAULT_TASKS
    task_meta = {}
    # A private repository's task folders go when its run ends; what the last report said of them stays.
    earlier = {t["id"]: t for t in earlier_tasks(job_dir / "report.json")}
    for task_id in sorted({t["task_id"] for t in trials} | set(meta.get("tasks", []))):
        path = tasks_dir / task_id
        if (path / "task.toml").is_file():
            task = load_task(path)
            info = task.meta["task"]
            task_meta[task_id] = {
                "id": task_id, "repo": info["repo"], "pr": info["pr_number"], "url": info["url"],
                "title": info["title"], "language": info["language"], "size": info["size_bucket"],
                "lines_changed": info["lines_changed"], "files_changed": info["files_changed"],
                "merged_at": info["merged_at"], "instruction": task.instruction,
                "reference_patch": read(path / "solution" / "reference.patch"),
                "test_scope": task.meta["verifier"].get("scope"),
            }
        else:
            task_meta[task_id] = earlier.get(task_id) or {"id": task_id, "repo": task_id.split("__")[0], "title": task_id}

    per_model = {k: summarize([t for t in trials if t["model"] == k]) for k in model_keys}

    slices = []
    for dimension, key in (("Language", "language"), ("Change size", "size"), ("Repository", "repo")):
        groups = defaultdict(list)
        for t in trials:
            groups[task_meta.get(t["task_id"], {}).get(key, "unknown")].append(t)
        order = ["small", "medium", "large"] if key == "size" else sorted(groups)
        for value in [v for v in order if v in groups]:
            group = groups[value]
            slices.append({"dimension": dimension, "value": value,
                           "tasks": len({t["task_id"] for t in group}),
                           "models": {k: summarize([t for t in group if t["model"] == k]) for k in model_keys}})

    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "run": meta, "models": models, "summary": per_model, "slices": slices,
            "timing": summarize_timing(trials, meta.get("created_at")),
            "tasks": list(task_meta.values()), "trials": trials, "judging": judging(trials),
            "complete": len(trials) == len(meta.get("tasks", [])) * len(models) * meta.get("attempts", 1),
            **escalated(meta, trials, per_model)}


def escalated(meta: dict, trials: list[dict], summary: dict[str, dict]) -> dict:
    """An escalation run's own part of its report: `escalation`, and `complete` once every task has finished
    (solved, or the last model has had its turn). Nothing for a run that sends every task to every model."""
    if not meta.get("escalation"):
        return {}
    data = escalation(meta, trials, summary)
    return {"escalation": data, "complete": data["remaining"] == 0}


def escalation(meta: dict, trials: list[dict], summary: dict[str, dict]) -> dict:
    """What an escalation run did with each task, cheapest model first: which models tried it and which solved it,
    how many each model solved, what the run cost, and what running every model on every task would have:
    the cost of the attempts that ran plus an estimate for those that didn't (`every_model`). The estimate for a
    model is the page's estimate when the run started (from earlier runs), else its cost per try in this run times
    the tries an attempt takes at its solve rate here, else a model of this run's scaled by output token price.
    Not its mean per attempt in this run: a model above the first ran only the tasks the ones below failed, the
    hard ones, which take every try. A cost counts every try of every attempt that ran, attempts not scored
    included. A task whose climb ended on an attempt that wasn't scored is `not_scored`, not unsolved."""
    plan = meta["escalation"]
    specs = {m["key"]: m for m in meta.get("models") or []}
    ladder = [k for k in plan["ladder"] if k in specs]
    tries = meta.get("tries", 1)
    first = {(t["task_id"], t["model"]): t for t in trials if (t.get("attempt") or 1) == 1}
    rows, solved_by, tried, unrun = [], dict.fromkeys(ladder, 0), dict.fromkeys(ladder, 0), dict.fromkeys(ladder, 0)
    spent, priced = 0.0, True
    for task_id in meta.get("tasks") or []:
        ran = {k: t for k in ladder if (t := first.get((task_id, k)))}
        winner = next((k for k in ladder if ran.get(k, {}).get("outcome") == "solved"), None)
        done = bool(ladder) and escalation_step(ladder, ran, tries) is None  # a lost attempt waits for a resume
        rows.append({"task_id": task_id, "solved_by": winner, "done": done,
                     "steps": [{"model": k, "outcome": t["outcome"],
                                **({"invalid_reason": t["invalid_reason"]} if t.get("invalid_reason") else {})}
                               for k, t in ran.items()]})
        if winner:
            solved_by[winner] += 1
        for k in ladder:
            if k not in ran:
                unrun[k] += 1
                continue
            tried[k] += 1
            costs = [(x.get("agent") or {}).get("cost_usd") for x in tries_of(ran[k])]
            if None in costs and ran[k]["outcome"] in ("solved", "failed"):
                priced = False  # a scored attempt without a price: the total isn't known
            spent += sum(c or 0 for c in costs)

    def estimate(key: str) -> tuple[float | None, str | None]:
        if (each := (plan.get("cost_per_attempt") or {}).get(key)) is not None:
            return each, "earlier runs"
        s = summary.get(key) or {}
        if (each := s.get("cost_per_try")) is not None and s.get("tries"):
            rate = (s.get("solved") or 0) / s["tries"]  # each try after the first runs only if the ones before failed
            return each * sum((1 - rate) ** n for n in range(tries)), "this run"
        mine = output_price(specs[key])
        for base in ladder:  # a model of this run, scaled by the two models' output token price
            theirs, each = output_price(specs[base]), (summary.get(base) or {}).get("cost_per_attempt")
            if mine and theirs and each is not None:
                return each * mine / theirs, "prices"
        return None, None

    estimates = {}
    for key in ladder:
        each, source = estimate(key) if unrun[key] else (None, None)
        estimates[key] = {"attempts": unrun[key], "cost_per_attempt": each, "source": source}
    known = all(e["cost_per_attempt"] is not None for e in estimates.values() if e["attempts"])
    guessed = sum(e["attempts"] * e["cost_per_attempt"] for e in estimates.values() if e["attempts"]) if known else None
    cost = spent if priced else None
    every = cost + guessed if cost is not None and guessed is not None else None
    remaining = sum(not r["done"] for r in rows)
    ended = [r for r in rows if r["done"] and not r["solved_by"]]
    not_scored = sum(bool(r["steps"]) and r["steps"][-1]["outcome"] == "invalid" for r in ended)
    return {"ladder": ladder, "tasks": rows, "solved_by": solved_by, "tried": tried,
            "unsolved": len(ended) - not_scored, "not_scored": not_scored, "remaining": remaining,
            "cost_usd": cost,
            "every_model": {"cost_usd": every, "estimated_usd": guessed, "estimated_attempts": sum(unrun.values()),
                            "estimates": estimates},
            # Only once every task has finished: a stopped run's estimate covers attempts that may yet run.
            "saving": 1 - cost / every if every and not remaining else None}


def output_price(spec: dict) -> float | None:
    """A model's price per million output tokens, from its entry in run.json."""
    model = Model.from_dict(spec)
    return (model.rate_for(model.model) or {}).get("output")


def judging(trials: list[dict]) -> dict[str, dict]:
    """What the judges' priced answers cost in this run, by judge model: {model: {"answers", "cost_usd"}}.
    The page prices a new run's judges from the latest run that measured each (app.App.measured)."""
    found: dict[str, dict] = {}
    for t in trials:
        verdict = t.get("judge") or {}
        for vote in [*(verdict.get("panel") or []), *([verdict["chair"]] if verdict.get("chair") else [])]:
            if vote.get("model") and vote.get("cost_usd") is not None:
                each = found.setdefault(vote["model"], {"answers": 0, "cost_usd": 0.0})
                each["answers"] += 1
                each["cost_usd"] = round(each["cost_usd"] + vote["cost_usd"], 6)
    return found


def earlier_tasks(path: Path) -> list[dict]:
    try:
        return [t for t in json.loads(path.read_text()).get("tasks") or [] if isinstance(t, dict) and t.get("id")]
    except (OSError, ValueError, AttributeError):
        return []


def build(job_dir: Path) -> Path:
    data = build_data(job_dir)
    # No credential is ever in a run's files; masking by value makes sure none reaches a reader.
    write_atomic(job_dir / "report.json", redact_known(json.dumps(data, indent=1)))
    target = job_dir / "report.html"
    write_atomic(target, html(data))
    return target


def html(data: dict) -> str:
    """A run's report page: the current template around its data."""
    # No "<" at all inside the script: "</script" would end it early, and "<!--<script" would keep the
    # real end tag from closing it. PR titles and diffs come from anyone's public repository.
    payload = redact_known(json.dumps(data)).replace("<", "\\u003c")
    title = f"Self-Serve Model Eval Sandbox · {data['run']['run_id']}"
    return TEMPLATE.read_text().replace("__REPORT_TITLE__", title).replace("__REPORT_DATA__", payload)


def current_html(job_dir: Path) -> bytes | None:
    """The report as the page looks today, from the run's report.json; a report.html written when the run
    finished keeps the design of that day. None when the run has no readable report.json."""
    try:
        data = json.loads((job_dir / "report.json").read_text())
        data["run"]["run_id"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return html(data).encode()


def write_atomic(path: Path, text: str) -> None:
    """The page reads reports while a run rewrites them; it must never see half a file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)
