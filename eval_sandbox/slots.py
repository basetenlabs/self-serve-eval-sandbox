"""Places shared by every run on one machine: how many attempts, and Claude Code judges, go at once in all.

The hosted page starts each run as a process of its own, and a run sizes itself alone: a quick sample runs
20 attempts at once, each holding up to two sandboxes. With several people running at once, each run takes
a place here for every check and attempt, and the page as a whole stays within the team's sandboxes, the
models' rate limits and this machine's memory. A run with fewer places than the others gets the next free
one, so a small run started beside a big one starts at once instead of waiting for it to finish.

Off unless PR_EVAL_ATTEMPTS_AT_ONCE (or PR_EVAL_JUDGES_AT_ONCE) is set: a local run sizes itself as before.
The places live in a small file under PR_EVAL_SLOTS_DIR (default: the temp directory), locked with flock, on
this machine's own disk. A process that dies gives its places back: the next one to look drops them.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import random
import tempfile
import time
import uuid
from pathlib import Path

LIMITS = {"attempts": "PR_EVAL_ATTEMPTS_AT_ONCE", "judges": "PR_EVAL_JUDGES_AT_ONCE"}
POLL_SECONDS = 1.0


def limit(kind: str) -> int | None:
    try:
        return int(os.environ.get(LIMITS[kind]) or 0) or None
    except ValueError:
        return None


def folder() -> Path:
    return Path(os.environ.get("PR_EVAL_SLOTS_DIR") or Path(tempfile.gettempdir()) / "pr-eval-slots")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@contextlib.contextmanager
def _locked(kind: str, write: bool = True):
    """The kind's places, read (and written back, unless `write` is False) under an exclusive lock."""
    base = folder()
    base.mkdir(parents=True, exist_ok=True)
    with open(base / f"{kind}.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            path = base / f"{kind}.json"
            try:
                state = json.loads(path.read_text())
            except (OSError, ValueError):
                state = {}
            state = {part: [t for t in state.get(part) or [] if isinstance(t, dict) and alive(int(t.get("pid") or 0))]
                     for part in ("held", "waiting")}
            yield state
            if write:
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(state))
                tmp.replace(path)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _take(kind: str, cap: int, ticket: dict) -> bool:
    """Takes a place for `ticket` if one is free and it is next in line: the waiting ticket whose run holds
    the fewest places, the earliest among those."""
    with _locked(kind) as state:
        held, waiting = state["held"], state["waiting"]
        if not any(t["id"] == ticket["id"] for t in waiting):
            waiting.append(ticket)
        if len(held) >= cap:
            return False
        count = {}
        for t in held:
            count[t["run"]] = count.get(t["run"], 0) + 1
        first = min(waiting, key=lambda t: (count.get(t["run"], 0), t["since"]))
        if first["id"] != ticket["id"]:
            return False
        waiting.remove(first)
        held.append(first)
        return True


def _leave(kind: str, ticket: dict) -> None:
    with _locked(kind) as state:
        for part in ("held", "waiting"):
            state[part] = [t for t in state[part] if t["id"] != ticket["id"]]


@contextlib.contextmanager
def hold(kind: str, run: str | None = None, stopping=lambda: False):
    """Holds one place of `kind` for `run` (default: this process) while the block runs. Yields True, or
    False without a place once `stopping()` says the run is stopping: the caller then does nothing."""
    cap = limit(kind)
    if not cap:
        yield True
        return
    ticket = {"id": uuid.uuid4().hex, "run": run or str(os.getpid()), "pid": os.getpid(), "since": time.time()}
    try:
        got = True
        while not _take(kind, cap, ticket):
            if stopping():
                got = False
                break
            time.sleep(POLL_SECONDS * (0.5 + random.random()))
        yield got
    finally:
        _leave(kind, ticket)


def usage(kind: str) -> dict | None:
    """{"held", "waiting", "limit"} right now, for the page; None when this kind has no limit."""
    cap = limit(kind)
    if not cap:
        return None
    with _locked(kind, write=False) as state:
        return {"held": len(state["held"]), "waiting": len(state["waiting"]), "limit": cap}
