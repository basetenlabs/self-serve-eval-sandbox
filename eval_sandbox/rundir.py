"""A run's folder under jobs/: the files more than one part of pr-eval reads or writes, and how.

The run's own process, the page and the key meter all work on the same folder, so its file names and
the way its JSON is read and written live here, below all of them.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

# Who started the run, when someone signed in did (hosted): {"owner", "private"}. Only they see it, and
# it counts toward their limits. The deploy's smoke runs say {"smoke": true}: no one's to see or limit.
ACCESS = "access.json"
# Why the page stopped the run for spending, until it resumes. The key meter refuses its calls meanwhile.
OVER_LIMIT = "over_limit.txt"
# Every model call the run pays for, one JSON line each: the hosted page's spending limits add these up
# by when they were spent. Unlike the report, it keeps attempts that ended invalid or were stopped,
# every judge, and attempts a resume runs again, each time they ran.
SPEND_LEDGER = "spend.jsonl"
_ledger_lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path) -> dict:
    """A JSON object from a file, or {} if it isn't there, isn't one, or can't be read right now."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json(path: Path, data: dict) -> None:
    """Write through a temporary file, so a run killed mid-write never leaves half a file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def charge(trial_dir: Path, kind: str, model: str, usd: float | None) -> None:
    """Add one charge (`kind` "agent", "judge" or "call") to the run's ledger; `usd` None means it ran
    but has no price."""
    if trial_dir.parent.name != "trials":  # not in a run's folder (a check, or a test): no run to charge
        return
    line = json.dumps({"at": now(), "kind": kind, "trial": trial_dir.name, "model": model,
                       "usd": None if usd is None else round(usd, 6)})
    try:
        with _ledger_lock, open(trial_dir.parent.parent / SPEND_LEDGER, "a") as ledger:
            ledger.write(line + "\n")
    except OSError as exc:  # the attempt's own records still hold it
        print(f"(spend not recorded for {trial_dir.name}: {exc})", flush=True)
