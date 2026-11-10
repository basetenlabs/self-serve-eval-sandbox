"""One-page report for a finished run: report.json plus a self-contained report.html.

Definitions:
- An attempt is *valid* unless setup, the harness, the provider, the verifier or the
  judge broke. Invalid attempts are reported separately and never count as failures.
- *Solve rate* (pass@1) is solved attempts / valid attempts.
- *Solved at least once* (pass@k) counts tasks with at least one solved attempt.
- *Cost per solved task* is everything spent on valid attempts / solved attempts, so a
  model that fails often pays for its failures.
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .config import redact_known
from .runner import ANSI
from .tasks import DEFAULT_TASKS
from .tasks import load as load_task

TEMPLATE = Path(__file__).with_name("report_template.html")
MAX_PATCH_CHARS = 40_000


def read(path: Path, limit: int = MAX_PATCH_CHARS) -> str | None:
    if not path.is_file():
        return None
    text = path.read_text(errors="replace")
    return text if len(text) <= limit else text[:limit] + f"\n... [{len(text) - limit} more characters in {path.name}]"


def tail(path: Path, lines: int = 60) -> str | None:
    if not path.is_file():
        return None
    return "\n".join(ANSI.sub("", path.read_text(errors="replace")).splitlines()[-lines:])


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


def summarize_timing(trials: list[dict], started_at: str | None = None) -> dict:
    """Elapsed is wall clock while attempts ran, plus the setup before the first one.

    Parallel attempts count once, and a stopped run's idle time before it was resumed
    not at all. Summed agent time can overlap across trials.
    """
    spans = [(datetime.fromisoformat(t["started_at"]), datetime.fromisoformat(t["finished_at"]))
             for t in trials if t.get("started_at") and t.get("finished_at")]
    first = min((s for s, _ in spans), default=None)
    start = datetime.fromisoformat(started_at) if started_at else first
    finish = max((f for _, f in spans), default=None)
    complete = len(spans) == len(trials)
    lead = max(0.0, (first - start).total_seconds()) if first and start else 0.0
    working = [(t.get("agent") or {}).get("working_seconds", (t.get("agent") or {}).get("seconds"))
               for t in trials]
    known = [seconds for seconds in working if seconds is not None]
    return {
        "started_at": start.isoformat() if start else None,
        "finished_at": finish.isoformat() if finish else None,
        "elapsed_seconds": lead + busy_seconds(spans) if complete and spans else None,
        "total_working_seconds": sum(known) if known else None,
        "timed_attempts": len(known),
        "attempts": len(trials),
    }


def summarize(trials: list[dict]) -> dict:
    valid = [t for t in trials if t["outcome"] in ("solved", "failed")]
    solved = [t for t in valid if t["outcome"] == "solved"]
    cost = sum((t.get("agent") or {}).get("cost_usd") or 0 for t in valid)
    priced = all((t.get("agent") or {}).get("cost_usd") is not None for t in valid)
    by_task = defaultdict(list)
    for t in valid:
        by_task[t["task_id"]].append(t)
    agent = [(t.get("agent") or {}) for t in valid]
    tokens = [a.get("tokens") or {} for a in agent]
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
        "median_seconds": median(a.get("working_seconds", a.get("seconds")) for a in agent),
        "median_seconds_with_waits": median(a.get("seconds") for a in agent),
        "rate_limited_attempts": sum(1 for a in agent if a.get("rate_limited_retries")),
        "median_turns": median(a.get("num_turns") for a in agent),
        "mean_output_tokens": statistics.mean(t.get("output", 0) for t in tokens) if tokens else None,
        "mean_input_tokens": statistics.mean(t.get("input", 0) + t.get("cached_input", 0) + t.get("cache_write", 0)
                                             for t in tokens) if tokens else None,
        "agent_timeouts": sum(1 for a in agent if a.get("timed_out")),
        # Attempts stopped at the time limit: cost rebuilt from the log; "partial" ones
        # are missing some output tokens, so the total is a slight undercount.
        "rebuilt_cost_attempts": sum(1 for a in agent if str(a.get("cost_source")).startswith("rebuilt")),
        "partial_cost_attempts": sum(1 for a in agent if a.get("cost_source") == "rebuilt-partial"),
        "judge_disagreements": sum(1 for t in valid if (t.get("tests") or {}).get("passed")
                                   and (t.get("judge") or {}).get("verdict") == "fail"),
    }


def trial_record(trial_dir: Path) -> dict | None:
    path = trial_dir / "result.json"
    if not path.is_file():
        return None
    r = json.loads(path.read_text())
    agent = r.get("agent") or {}
    if agent.get("seconds") is not None:  # time spent backing off from rate limits is the provider's, not the model's
        agent["working_seconds"] = max(agent["seconds"] - (agent.get("retry_wait_seconds") or 0), 0)
    return {
        "trial": r["trial"], "task_id": r["task_id"], "model": r["model"], "attempt": r["attempt"],
        "outcome": r["outcome"], "invalid_reason": r.get("invalid_reason"),
        "started_at": r.get("started_at"), "finished_at": r.get("finished_at"),
        "agent": {k: agent.get(k) for k in ("seconds", "working_seconds", "api_retries", "rate_limited_retries",
                                            "retry_wait_seconds", "timed_out", "num_turns", "tool_calls", "tokens",
                                            "cost_usd", "cost_source", "claude_code_cost_usd", "subtype",
                                            "is_error", "final_message")} if agent else None,
        "diff": r.get("diff"), "tests": r.get("tests"), "judge": r.get("judge"), "setup": r.get("setup"),
        "patch": read(trial_dir / "agent.patch"),
        "verifier_tail": tail(trial_dir / "verifier.log", 40),
    }


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
