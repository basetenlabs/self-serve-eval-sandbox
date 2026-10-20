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


def summarize_timing(trials: list[dict], started_at: str | None = None) -> dict:
    """Elapsed span is wall clock; summed agent time can overlap across trials."""
    starts = [datetime.fromisoformat(t["started_at"]) for t in trials if t.get("started_at")]
    finishes = [datetime.fromisoformat(t["finished_at"]) for t in trials if t.get("finished_at")]
    start = datetime.fromisoformat(started_at) if started_at else min(starts, default=None)
    finish = max(finishes, default=None)
    complete = len(starts) == len(finishes) == len(trials)
    working = [(t.get("agent") or {}).get("working_seconds", (t.get("agent") or {}).get("seconds"))
               for t in trials]
    known = [seconds for seconds in working if seconds is not None]
    return {
        "started_at": start.isoformat() if start else None,
        "finished_at": finish.isoformat() if finish else None,
        "elapsed_seconds": max(0, (finish - start).total_seconds()) if complete and start and finish else None,
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
    task_meta = {}
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
            task_meta[task_id] = {"id": task_id, "repo": task_id.split("__")[0], "title": task_id}

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


def build(job_dir: Path) -> Path:
    data = build_data(job_dir)
    write_atomic(job_dir / "report.json", json.dumps(data, indent=1))
    html = TEMPLATE.read_text()
    payload = json.dumps(data).replace("</", "<\\/")  # never close the script tag early
    html = html.replace("__REPORT_DATA__", payload).replace("__REPORT_TITLE__", f"PR eval · {data['run']['run_id']}")
    target = job_dir / "report.html"
    write_atomic(target, html)
    return target


def write_atomic(path: Path, text: str) -> None:
    """The page reads reports while a run rewrites them; it must never see half a file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)
