"""One-page report for a finished run: report.json plus a self-contained report.html.

Definitions:
- An attempt is *valid* unless setup, the harness, the provider, the verifier or the
  judge broke. Invalid attempts are reported separately and never count as failures.
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
from .config import redact_known
from .runner import ANSI
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
            "tasks": list(task_meta.values()), "trials": trials,
            "complete": len(trials) == len(meta.get("tasks", [])) * len(models) * meta.get("attempts", 1)}


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
