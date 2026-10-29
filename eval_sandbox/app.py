"""The local page: pick pull requests and models, start a run, watch it, open its report.

`pr-eval serve` starts it on 127.0.0.1. A run started here is an ordinary `pr-eval run`
in a process of its own, logging to jobs/<run>/log.txt, so the page and the terminal do
the same thing and a run keeps going if the page is closed.
"""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from . import config, pipeline, runner, runtime, tasks, trace

PAGE = Path(__file__).with_name("app.html")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RUN_ID = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")  # never "." or ".."
# The only files under jobs/ the page serves: each run's report. Transcripts, logs and
# diffs stay on disk; an attempt's trace goes out condensed and redacted, by /api/trace.
REPORT_FILE = re.compile(r"/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/report\.(html|json)")
MAX_LIMIT = 50
PICK_COUNT, MAX_PICK_COUNT = 30, 90  # latest merges the picker lists at first, and at most
QUICK_CONCURRENCY = 20  # every attempt of the quick sample with two models starts at once
# Hosted, people can sign in with GitHub (device flow: a GitHub App's client id, no secret). The app
# reads only Contents, Pull requests and Metadata, and only on the repositories each person installs
# it on. Their token, kept in memory only, reads and clones those private repositories for them, and
# a run on a private repository is theirs alone to see. The sign-in server in front of the hosted
# page (@blaxel/sign-in) names who is asking in USER_HEADER, after dropping any value the browser
# sent itself; locally there is no sign-in and no header, and the `gh` login reads everything.
GITHUB_CLIENT_ID = os.environ.get("PR_EVAL_GITHUB_CLIENT_ID")
GITHUB_APP = os.environ.get("PR_EVAL_GITHUB_APP")  # the app's slug, for the page that adds repositories to it
USER_HEADER = "x-forwarded-email"
# Hosted: the public origin. The sign-in server has checked a write's Origin against it before passing it on.
APP_ORIGIN = os.environ.get("APP_ORIGIN")
ACCESS = "access.json"  # in a run's folder started by someone signed in: its owner, and whether only they see it
MAX_FAVORITES = 200
# Hosted, everyone shares one Blaxel workspace and one set of model keys: how many runs may go at once,
# in all and for one person, and how much runs started in the last day may cost (the agents' cost, as
# reports count it), in all and for one person. Locally: one run at a time and no spending limit.
MAX_RUNS = int(os.environ.get("PR_EVAL_MAX_RUNS") or 1)
RUNS_PER_PERSON = int(os.environ.get("PR_EVAL_RUNS_PER_PERSON") or 1)
SPEND_TOTAL = float(os.environ.get("PR_EVAL_SPEND_TOTAL") or 0) or None
SPEND_PER_PERSON = float(os.environ.get("PR_EVAL_SPEND_PER_PERSON") or 0) or None
SPEND_WINDOW = timedelta(days=1)
# Blaxel sandboxes an attempt holds at each stage: its own and the verifier being readied
# beside it, then the verifier alone once the agent's sandbox is deleted. One set up while
# its task is still checked holds only its own: the verifier comes once the check passes.
SANDBOXES = {"sandboxes": 2, "setup": 2, "agent": 2, "tests": 1}
CHECK_STAGES = ("sandboxes", "setup", "base", "reference")


def parse_repo(text: str) -> str | None:
    """owner/repo from what people paste: owner/repo, a GitHub URL, or a clone URL."""
    text = text.strip()
    if match := re.match(r"(?:https?://|git@)?(?:www\.)?github\.com[/:]([^/\s]+/[^/\s#?]+)", text):
        text = match[1]
    text = text.removesuffix(".git").strip("/")
    return text if REPO.fullmatch(text) else None


def alive(pid: int | None) -> bool:
    """Whether a run's process is still going (and is still a pr-eval process)."""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    command = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    return "eval_sandbox" in command or "pr-eval" in command


def repo_of(task_id: str) -> str:
    return task_id.rsplit("-", 1)[0].replace("__", "/")


class App:
    def __init__(self, jobs_dir: Path, models_config: Path = config.DEFAULT_MODELS):
        self.jobs_dir = jobs_dir
        self.models_config = models_config
        self.children: dict[str, subprocess.Popen] = {}  # runs started here, so finished ones are reaped
        self.lock = threading.RLock()  # one start or resume at a time, so two tabs can't start two runs
        self.checked: tuple[float, dict] = (0.0, {})
        self.checking = threading.Lock()  # one refresh of the remote checks at a time
        self.task_info: dict[Path, dict] = {}
        self.browsed: dict[str, tuple[float, dict]] = {}  # PR listings, kept a few minutes
        self.repos: dict[str, tuple[float, dict]] = {}  # GitHub's answer about each repository, kept a minute
        self.github: dict[str, dict] = {}  # signed-in person: their GitHub token and login, never on disk
        self.devices: dict[str, dict] = {}  # GitHub sign-ins waiting for the person to approve them
        self.claims: dict[str, set[str] | None] = {}  # repositories of each run started here, before its run.json
        self.favorites_file = jobs_dir.parent / "data" / "favorites.json"

    # ---------- what the page shows ----------

    def state(self, viewing: str = "", user: str | None = None) -> dict:
        for child in list(self.children.values()):
            child.poll()
        catalog, judge = config.load(self.models_config)
        everyone = self.everyone()
        runs = [r for d, r in everyone if self.visible(d, user)]
        for d, run in everyone:
            run["private"] = bool(read_json(d / ACCESS).get("private"))
        runs.sort(key=lambda r: r["active_at"], reverse=True)
        for i, run in enumerate(runs):  # the board: every run going, the latest one and the one on screen
            if i == 0 or run["phase"] in pipeline.ACTIVE or run["id"] == viewing:
                run["board"] = self.board(run)
        estimates = self.estimates(runs)
        models = [{"key": m.key, "label": m.label, "kind": m.kind, "provider": m.provider, "model": m.model,
                   "missing": config.missing_credential(m), "default": m.key in pipeline.DEFAULT_MODELS,
                   **estimates.get(m.key, {})} for m in catalog.values()]
        return {"checks": self.checks(judge), "models": models, "runs": runs,
                "quick": {"tasks": sum(map(len, tasks.sample(True).values())), "repos": len(tasks.sample(True))},
                "default_limit": pipeline.DEFAULT_LIMIT, "max_limit": MAX_LIMIT,
                "busy": any(r["phase"] in pipeline.ACTIVE for _, r in everyone),
                **self.limits(everyone, runs, user),
                "github": self.github_state(user), "favorites": self.favorites(user)}

    def everyone(self) -> list[tuple[Path, dict]]:
        """Every run, whoever may see it."""
        return [(d, r) for d in self.jobs_dir.iterdir() if d.is_dir() and (r := self.describe(d))] \
            if self.jobs_dir.is_dir() else []

    def limits(self, everyone: list[tuple[Path, dict]], runs: list[dict], user: str | None) -> dict:
        """`blocked`: why this person can't start a run now, if they can't. `spend`: what their runs
        started in the last day cost, and their limit, when there is one."""
        since = (datetime.now(timezone.utc) - SPEND_WINDOW).isoformat(timespec="seconds")
        going = mine = 0
        spent = my_spent = 0.0
        for d, run in everyone:
            own = bool(user) and read_json(d / ACCESS).get("owner") == user
            if run["phase"] in pipeline.ACTIVE:
                going, mine = going + 1, mine + own
            if (run["started"] or since) >= since:  # ISO times in UTC sort as text
                spent, my_spent = spent + run["cost"], my_spent + run["cost"] * own
        mine_cap = SPEND_PER_PERSON if user else None
        if user and mine >= RUNS_PER_PERSON:
            blocked = "Your run is still going. Start another when it finishes, or stop it." if RUNS_PER_PERSON == 1 \
                else f"You have {mine} runs going, the most for one person. Start another when one finishes."
        elif going >= MAX_RUNS:
            blocked = f"{going} runs are going, the most at once. Start yours when one finishes." if MAX_RUNS > 1 \
                else "A run is already going. Let it finish, or stop it, before starting another." \
                if any(r["phase"] in pipeline.ACTIVE for r in runs) else "Someone else's run is going. Start yours when it finishes."
        elif mine_cap and my_spent >= mine_cap:
            blocked = (f"You've reached your {usd(mine_cap)} limit: your runs from the last 24 hours cost {usd(my_spent)}. "
                       "Each run stops counting a day after it started.")
        elif SPEND_TOTAL and spent >= SPEND_TOTAL:
            blocked = (f"This page has reached its {usd(SPEND_TOTAL)} limit: runs from the last 24 hours cost {usd(spent)}. "
                       "Each run stops counting a day after it started.")
        else:
            blocked = None
        return {"blocked": blocked, "spend": {"spent": my_spent, "cap": mine_cap} if mine_cap else None,
                "spent_total": spent}

    def checks(self, judge: config.Panel) -> dict:
        """Dedicated Blaxel workspace, build CLI and GitHub. The remote checks take seconds, so only the
        first waits for them: after that the page gets the last answer, and one older than 15 seconds
        is checked again in the background."""
        when, cached = self.checked
        if not cached:
            with self.checking:
                cached = self.checked[1] or self.check(judge)
        elif time.monotonic() - when > 15 and self.checking.acquire(blocking=False):
            def refresh():
                try:
                    self.check(judge)
                finally:
                    self.checking.release()
            threading.Thread(target=refresh, daemon=True).start()
        return {**cached, "judge": {"label": judge.label, "chair": judge.chair.name if judge.chair else None,
                                    "effort": judge.judges[0].effort, "ok": not cached["judge"], "problem": cached["judge"]}}

    def check(self, judge: config.Panel) -> dict:
        problem = None
        image = False
        bl_cli = bool(shutil.which("bl"))
        try:
            runtime.check_connection()
            image = bl_cli and pipeline.image_exists(runner.DEFAULT_IMAGE)
        except RuntimeError as exc:
            problem = str(exc)
        gh = bool(shutil.which("gh")) and subprocess.run(["gh", "auth", "status"], capture_output=True).returncode == 0
        try:
            gh_login = tasks.gh("user").get("login") if gh else None
        except (RuntimeError, SystemExit, subprocess.SubprocessError):
            gh_login = None
        checked = {"blaxel": problem is None, "blaxel_problem": problem,
                   "bl_cli": bl_cli, "gh": gh, "gh_login": gh_login, "image": image, "judge": judge.problem()}
        self.checked = (time.monotonic(), checked)
        return checked

    def describe(self, job_dir: Path) -> dict | None:
        log = job_dir / "log.txt"
        if not (job_dir / "run.json").is_file():  # started from the page a moment ago
            child = self.children.get(job_dir.name)
            if not child:
                return None
            starting = child.poll() is None
            return {"id": job_dir.name, "title": job_dir.name, "models": [], "started": None, "tasks": 0,
                    "active_at": pipeline.now(), "phase": "collecting" if starting else "failed",
                    "detail": "Starting" if starting else "The run stopped before it began; see its log.",
                    "note": None, "progress": {"done": 0, "total": 0}, "checking": {"done": 0, "total": 0},
                    "left_out": [], "summary": {}, "report": None, "lost": 0, "resumable": False, "cost": 0.0,
                    "log": None if starting else tail(log)}
        meta = read_json(job_dir / "run.json")
        if not meta:
            return None
        status = meta.get("status") or {}
        phase, detail = status.get("phase"), status.get("detail") or ""
        models = meta.get("models") or []
        attempts = meta.get("attempts", 1)
        run_tasks = meta.get("tasks") or []
        done = len(list((job_dir / "trials").glob("*/result.json"))) if (job_dir / "trials").is_dir() else 0
        last = [meta.get("created_at") or "", status.get("updated_at") or ""]
        total = len(run_tasks) * len(models) * attempts
        child = self.children.get(job_dir.name)
        if child and child.poll() is None and phase not in pipeline.ACTIVE:
            phase, detail = "collecting", "Starting"  # resumed a moment ago; its status comes next
        elif phase is None:  # runs from before status was recorded
            phase = "done" if total and done >= total else "stopped"
        elif phase in pipeline.ACTIVE and not alive(status.get("pid")):
            phase, detail = "stopped", "The run's process ended before it finished. Resume to carry on."
        request = meta.get("request") or {}
        repos = sorted({repo_of(t) for t in run_tasks})
        sample = {f"{r.replace('/', '__')}-{n}" for r, prs in tasks.sample().items() for n in prs}
        if named := list(dict.fromkeys([*(request.get("repos") or []), *(request.get("pulls") or {})])):
            title = ", ".join(named)
        elif request.get("quick"):
            title = "Quick sample"
        elif (run_tasks and set(run_tasks) <= sample) or (request and not request.get("task_ids")):
            title = "Sample tasks"
        else:
            title = repos[0] if len(repos) == 1 else f"{len(run_tasks)} tasks from {len(repos)} repositories"
        summary = {}
        report_json = job_dir / "report.json"
        if data := read_json(report_json):
            last += [t.get("finished_at") or "" for t in data["trials"]]
            summary = {m["key"]: {k: data["summary"][m["key"]].get(k) for k in
                                  ("pass_at_1", "solved", "valid", "cost_per_solved", "invalid")}
                       for m in data["models"] if m["key"] in data["summary"]}
        lost = sum(map(runner.lost, data.get("trials") or []))  # resume runs these again
        candidates = meta.get("candidates") or []
        tasks_dir = Path(meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
        return {
            "id": job_dir.name, "title": title, "started": meta.get("created_at"), "tasks": len(run_tasks),
            "active_at": max(last),  # ISO times in UTC sort as text
            "models": [{"key": m["key"], "label": m["label"], "kind": m.get("kind"), "model": m.get("model")} for m in models],
            "phase": phase, "detail": detail, "note": meta.get("note"), "judged": bool(meta.get("judge")),
            "progress": {"done": done, "total": total},
            "checking": {"done": sum((tasks_dir / c / "validation" / "result.json").is_file() for c in candidates),
                         "total": len(candidates)},
            "left_out": [{"id": t, "pr": t.rsplit("-", 1)[-1], "why": pipeline.LEFT_OUT.get(s, s)}
                         for t, s in (meta.get("left_out") or {}).items()],
            "summary": summary, "report": f"{job_dir.name}/report.html" if (job_dir / "report.html").is_file() else None,
            "cost": sum(s.get("cost_usd") or 0 for s in (data.get("summary") or {}).values()),  # so far, while it goes
            "log": tail(log) if phase in ("failed", "stopped") else None, "lost": lost,
            "resumable": (phase in ("stopped", "failed") or (phase == "done" and lost > 0)) and meta.get("backend") == "blaxel"
                         and bool(meta.get("workspace") and (meta.get("request") or run_tasks)),
            "again": again(meta),
        }

    def board(self, run: dict) -> dict:
        """Every PR in the run and what each model's attempt on it is doing now, for the live view."""
        job_dir = self.jobs_dir / run["id"]
        meta = read_json(job_dir / "run.json")
        tasks_dir = Path(meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
        active = run["phase"] in pipeline.ACTIVE
        kept, left = set(meta.get("tasks") or []), meta.get("left_out") or {}
        models, attempts = [m["key"] for m in meta.get("models") or []], meta.get("attempts", 1)
        rows, sandboxes = [], 0
        for task_id in meta.get("candidates") or meta.get("tasks") or []:
            info = self.task(tasks_dir / task_id)
            if task_id in kept:
                check = {"stage": "passed"}
            elif task_id in left:
                check = {"stage": "left-out", "why": pipeline.LEFT_OUT.get(left[task_id], left[task_id])}
            else:
                live = read_json(tasks_dir / task_id / "validation" / "stage.json")
                check = live if active and live.get("run_id") == run["id"] else {"stage": "queued" if active else "stopped"}
                sandboxes += check["stage"] in CHECK_STAGES
            cells = []
            for key in models:
                for attempt in range(1, attempts + 1):
                    trial = job_dir / "trials" / f"{task_id}__{key}__{attempt}"
                    if done := read_json(trial / "result.json"):
                        cells.append(cell(key, attempt, done))
                    elif task_id in left:
                        cells.append({"model": key, "attempt": attempt, "stage": "left-out"})
                    elif (live := read_json(trial / "stage.json")) and active:
                        sandboxes += SANDBOXES.get(live["stage"], 0) if task_id in kept else 1
                        cells.append({"model": key, "attempt": attempt, **live})
                    else:
                        cells.append({"model": key, "attempt": attempt,
                                      "stage": ("queued" if task_id in kept else "waiting") if active else "not-run"})
            rows.append({"id": task_id, **info, "check": check, "cells": cells})
        return {"rows": rows, "sandboxes": sandboxes, "concurrency": meta.get("concurrency")}

    def task(self, path: Path) -> dict:
        """A task's repository, PR and title; cached, since a task folder doesn't change."""
        if path not in self.task_info:
            try:
                meta = tomllib.loads((path / "task.toml").read_text())["task"]
            except (OSError, tomllib.TOMLDecodeError, KeyError):
                return {"repo": repo_of(path.name), "pr": path.name.rsplit("-", 1)[-1], "title": "", "language": ""}
            self.task_info[path] = {"repo": meta["repo"], "pr": meta["pr_number"], "title": meta.get("title", ""),
                                    "language": meta.get("language", ""), "url": meta.get("url"),
                                    "lines": meta.get("lines_changed")}
        return self.task_info[path]

    def estimates(self, runs: list[dict]) -> dict[str, dict]:
        """Cost and time per attempt for each model, from the most recent run that has them, and from the
        most recent over each set of repositories (`by_scope`): a large repository costs far more per attempt."""
        found: dict[str, dict] = {}
        for run in runs:  # newest first
            job_dir = self.jobs_dir / run["id"]
            meta = read_json(job_dir / "run.json")
            scope = "quick" if (meta.get("request") or {}).get("quick") \
                else ",".join(sorted({repo_of(t).lower() for t in meta.get("tasks") or []}))
            for key, s in (read_json(job_dir / "report.json").get("summary") or {}).items():
                if s.get("valid") and s.get("cost_per_attempt") is not None:
                    each = {"cost_per_attempt": s["cost_per_attempt"], "seconds_per_attempt": s["median_seconds"]}
                    found.setdefault(key, {**each, "by_scope": {}})["by_scope"].setdefault(scope, each)
        return found

    def repo_info(self, text: str, user: str | None = None) -> dict:
        repo = parse_repo(text)
        if not repo:
            return {"error": "Use owner/repo or a GitHub link."}
        token = self.token(user)
        # The page asks about a repository several times as it's picked (its pull requests, the saved
        # ones, a search, the start), so GitHub's answer is kept a minute. A failure isn't kept: after
        # adding the repository to the GitHub App, the person comes back and the page looks again.
        key = f"{user if token else ''}|{repo.lower()}"
        when, data = self.repos.get(key, (0.0, None))
        if not data or time.monotonic() - when > 60:
            try:
                data = tasks.gh(f"repos/{repo}", token)
            except (RuntimeError, SystemExit) as exc:
                if token and "HTTP 401" in str(exc):  # their sign-in ran out, or they revoked it on GitHub
                    self.github.pop(user, None)
                    return {"repo": repo, "error": "Your GitHub sign-in ran out. Sign in with GitHub again."}
                if token and GITHUB_APP:  # a private repository the app isn't installed on reads as missing
                    return {"repo": repo, "install": install_url(),
                            "error": f"Can't read {repo} yet: add it to Baseten Eval Sandbox on GitHub, then come back."}
                return {"repo": repo, "error": f"Can't read {repo} with your GitHub login ({str(exc)[-80:]})."}
            self.repos[key] = (time.monotonic(), data)
        # The hosted page's own GitHub login is shared by everyone signed in: it never reads
        # private code. A private repository needs the visitor's own GitHub sign-in.
        if data.get("private") and os.environ.get("PR_EVAL_PUBLIC_REPOS_ONLY") and not token:
            return {"repo": repo, "error": "Sign in with GitHub to use a private repository." if GITHUB_CLIENT_ID
                    else "This hosted page runs public repositories only."}
        language = data.get("language") or "unknown"
        try:
            tasks.recipe(repo, language, [])
            defaults = True
        except tasks.Skip:
            defaults = False
        return {"repo": repo, "language": language, "private": data.get("private"), "defaults": defaults}

    def pulls(self, text: str, numbers: str = "", count: str = "", words: str = "", user: str | None = None) -> dict:
        """Pull requests in a repository and which can be tasks: these numbers, the merged ones GitHub
        finds for these words, or the latest `count` merged."""
        repo, wanted = parse_repo(text), [int(n) for n in re.findall(r"\d+", numbers)][:MAX_LIMIT]
        latest = min(max(int(count) if count.isdigit() else PICK_COUNT, 1), MAX_PICK_COUNT)
        token = self.token(user)
        key = f"{user if token else ''}|{repo}#{','.join(map(str, wanted))}@{latest}?{words.strip().lower()}"
        when, found = self.browsed.get(key, (0.0, None))
        if found and time.monotonic() - when < 300:  # a listing found a moment ago: GitHub isn't asked at all
            return found
        info = self.repo_info(text, user)
        if info.get("error"):
            return info
        try:
            if words.strip() and not wanted:
                wanted = tasks.search(repo, words, token)
                if not wanted:
                    return {**info, "prs": []}
            found = {**info, "prs": tasks.browse(repo, wanted, latest, token)}
        except (RuntimeError, SystemExit) as exc:
            return {"repo": repo, "error": f"Can't list {repo}'s pull requests ({str(exc)[-80:]})."}
        self.browsed[key] = (time.monotonic(), found)
        return found

    def trace(self, run_id: str, trial: str, user: str | None = None) -> dict:
        """One attempt's trace, condensed and redacted."""
        path = self.jobs_dir / run_id / "trials" / trial
        if not (RUN_ID.fullmatch(run_id) and RUN_ID.fullmatch(trial) and path.is_dir()
                and self.visible(self.jobs_dir / run_id, user)):
            return {"error": "No such attempt."}
        return trace.load(path) or {"error": "This attempt has no trace: its agent hasn't finished, or never ran."}

    # ---------- what the page does ----------

    def start(self, form: dict, user: str | None = None) -> dict:
        with self.lock:
            return self._start(form, user)

    def _start(self, form: dict, user: str | None = None) -> dict:
        state = self.state(user=user)
        if state.get("blocked"):
            return {"error": state["blocked"]}
        checks = state["checks"]
        if not checks["blaxel"]:
            return {"error": checks["blaxel_problem"]}
        if not checks["bl_cli"]:
            return {"error": "Install the Blaxel CLI (bl): runs use it to build and find the trial image."}
        quick = bool(form.get("quick"))
        pulls = {} if quick else self.chosen_pulls(form.get("pulls"))
        if isinstance(pulls, str):
            return {"error": pulls}
        repo = None if quick or pulls else parse_repo(str(form.get("repo") or ""))
        if not (quick or pulls or repo):
            return {"error": "Enter a GitHub repository as owner/repo, or paste pull request links."}
        if not checks["gh"]:
            return {"error": "Sign in to GitHub first: run `gh auth login` in a terminal."}
        keys = [k for k in form.get("models") or [] if isinstance(k, str)]
        if not keys:
            return {"error": "Choose at least one model."}
        try:  # the judges were checked with the page's other checks, a few seconds ago: asking them again took seconds
            pipeline.preflight(keys, "none", self.models_config)
        except SystemExit as exc:
            return {"error": str(exc.code)}
        if checks["judge"]["problem"]:
            return {"error": checks["judge"]["problem"]}
        try:
            limit = int(form.get("limit") or pipeline.DEFAULT_LIMIT)
        except ValueError:
            return {"error": "The number of pull requests has to be a number."}
        if not 1 <= limit <= MAX_LIMIT:
            return {"error": f"Choose between 1 and {MAX_LIMIT} pull requests."}
        setup, test = (str(form.get(k) or "").strip()[:500] or None for k in ("setup", "test"))
        repos = list(pulls) or ([repo] if repo else [])
        if setup and test and len(repos) > 1:
            return {"error": "Install and test commands are for one repository: paste pull requests from one at a time."}
        private = False
        for name in repos if os.environ.get("PR_EVAL_PUBLIC_REPOS_ONLY") or not (setup and test) else []:
            info = self.repo_info(name, user)
            if info.get("error"):
                return info
            private = private or bool(info.get("private"))
            if not info["defaults"] and not (setup and test):
                return {"error": f"{name} is {info['language']}: give the install and test commands "
                                 "(Go and Python repositories have defaults)."}
        claim = None if quick else {name.lower() for name in repos}
        if problem := self.taken(claim) or self.over_budget(state, keys, state["quick"]["tasks"] if quick else
                                                            sum(map(len, pulls.values())) or limit,
                                                            "quick" if quick else ",".join(sorted(claim)), user):
            return {"error": problem}
        run_id = named = f"{repos[0].split('/')[-1] if repos else 'quick'}-{datetime.now():%Y%m%d-%H%M%S}"
        for n in range(2, 100):  # two people may start the same kind of run in the same second
            if not (self.jobs_dir / run_id).exists():
                break
            run_id = f"{named}-{n}"
        argv = [f"{name}#{n}" for name, numbers in pulls.items() for n in numbers] or ([repo] if repo else [])
        argv += ["--quick", "--concurrency", str(QUICK_CONCURRENCY)] if quick else [] if pulls else ["--limit", str(limit)]
        argv += ["--models", ",".join(keys), "--name", run_id, "--judges-checked"]
        argv += ["--setup", setup] if setup else []
        argv += ["--test", test] if test else []
        if user:  # whose run it is, for their limits; on a private repository, only they see it
            (self.jobs_dir / run_id).mkdir(parents=True, exist_ok=True)
            (self.jobs_dir / run_id / ACCESS).write_text(json.dumps({"owner": user, "private": private}))
        self.claims[run_id] = claim
        self.spawn(run_id, argv, self.token(user))
        return {"id": run_id}

    def taken(self, claim: set[str] | None, resuming: str | None = None) -> str | None:
        """Why a run on these repositories (None: the quick sample) can't start beside the runs going:
        two runs on one repository would clone it, collect its pull requests and check them at once.
        The quick sample's tasks are collected and checked once, so its runs only read them."""
        sample = {name.lower() for name in tasks.sample(True)}
        for d, run in self.everyone() if MAX_RUNS > 1 else []:
            if run["phase"] not in pipeline.ACTIVE or run["id"] == resuming:
                continue
            theirs = self.repos_of(d)
            if claim is None and theirs is None:
                continue
            if shared := sorted((sample if claim is None else claim) & (sample if theirs is None else theirs)):
                return f"Another run is using {shared[0]} right now. Start yours when it finishes."
        return None

    def repos_of(self, job_dir: Path) -> set[str] | None:
        """The repositories a run reads, lower case; None for the quick sample."""
        meta = read_json(job_dir / "run.json")
        if not meta:
            return self.claims.get(job_dir.name, set())
        request = meta.get("request") or {}
        if request.get("quick"):
            return None
        named = [*(request.get("repos") or []), *(request.get("pulls") or {})]
        return {name.lower() for name in [*named, *map(repo_of, meta.get("candidates") or meta.get("tasks") or [])]}

    @staticmethod
    def over_budget(state: dict, keys: list[str], count: int, scope: str, user: str | None) -> str | None:
        """Why a run of `count` pull requests with these models would go over a spending limit, from each
        model's cost per attempt as the page estimates it. A model with no earlier run counts nothing."""
        if not (SPEND_TOTAL or (SPEND_PER_PERSON and user)):
            return None
        cost = sum(((m.get("by_scope") or {}).get(scope) or m).get("cost_per_attempt") or 0
                   for m in state["models"] if m["key"] in keys) * count
        mine = state.get("spend")
        if mine and cost > mine["cap"] - mine["spent"]:
            return (f"This run would cost about {usd(cost)}, and you have {usd(max(0, mine['cap'] - mine['spent']))} "
                    f"left of your {usd(mine['cap'])} for the last 24 hours. Choose fewer pull requests or models.")
        if SPEND_TOTAL and cost > SPEND_TOTAL - state["spent_total"]:
            return (f"This run would cost about {usd(cost)}, and this page has {usd(max(0, SPEND_TOTAL - state['spent_total']))} "
                    f"left of its {usd(SPEND_TOTAL)} for the last 24 hours. Choose fewer pull requests or models.")
        return None

    @staticmethod
    def chosen_pulls(value) -> dict[str, list[int]] | str:
        """{owner/repo: [numbers]} from the page, or what's wrong with it."""
        pulls: dict[str, list[int]] = {}
        for name, numbers in (value or {}).items() if isinstance(value, dict) else []:
            repo = parse_repo(str(name))
            if not repo or not isinstance(numbers, list) or not all(isinstance(n, int) and n > 0 for n in numbers):
                return "Pull requests are owner/repo and their numbers."
            pulls[repo] = sorted(set(pulls.get(repo, []) + numbers))
        if sum(map(len, pulls.values())) > MAX_LIMIT:
            return f"Choose at most {MAX_LIMIT} pull requests."
        return {repo: numbers for repo, numbers in pulls.items() if numbers}

    def stop(self, run_id: str, user: str | None = None) -> dict:
        run = self.find(run_id, user)
        if not run or run["phase"] not in pipeline.ACTIVE:
            return {"error": "That run isn't going."}
        child = self.children.get(run_id)
        if child and child.poll() is None:
            pid = child.pid  # started or resumed from here, maybe before its status says so
        else:
            pid = (read_json(self.jobs_dir / run_id / "run.json").get("status") or {}).get("pid")
        if not alive(pid):
            return {"error": "That run's process has already ended."}
        os.kill(pid, signal.SIGINT)  # the run removes its sandboxes and marks itself stopped
        return {"ok": True}

    def resume(self, run_id: str, user: str | None = None) -> dict:
        with self.lock:
            return self._resume(run_id, user)

    def _resume(self, run_id: str, user: str | None = None) -> dict:
        run = self.find(run_id, user)
        if not run or not run["resumable"]:
            return {"error": "That run can't be resumed."}
        if blocked := self.state(user=user)["blocked"] or self.taken(self.repos_of(self.jobs_dir / run_id), run_id):
            return {"error": blocked}
        if read_json(self.jobs_dir / run_id / ACCESS).get("private") and not self.token(user):
            return {"error": "Sign in with GitHub to resume a run on a private repository."}
        self.spawn(run_id, ["--resume", str(self.jobs_dir / run_id)], self.token(user))
        return {"id": run_id}

    def find(self, run_id: str, user: str | None = None) -> dict | None:
        path = self.jobs_dir / run_id
        return self.describe(path) if RUN_ID.fullmatch(run_id) and path.is_dir() and self.visible(path, user) else None

    def visible(self, job_dir: Path, user: str | None) -> bool:
        """Whether this person may see the run: everyone may, unless someone else started it on a private repository."""
        access = read_json(job_dir / ACCESS)
        return not access.get("private") or access.get("owner") == user

    def spawn(self, run_id: str, argv: list[str], github_token: str | None = None) -> None:
        """`pr-eval run` in a process of its own, so it outlives the page and the server.

        With a visitor's GitHub token, the run reads and clones with it instead of the page's login.
        """
        with self.lock:
            job_dir = self.jobs_dir / run_id
            job_dir.mkdir(parents=True, exist_ok=True)
            with open(job_dir / "log.txt", "ab") as log:
                self.children[run_id] = subprocess.Popen(
                    [sys.executable, "-m", "eval_sandbox", "run", *argv, "--jobs", str(self.jobs_dir)], cwd=pipeline.ROOT,
                    env={**os.environ, "GH_TOKEN": github_token} if github_token else None,
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

    # ---------- GitHub sign-in (hosted) ----------

    # GitHub's deadlines follow the clock, not time.monotonic(): the hosted sandbox sleeps when nobody
    # uses it, and monotonic time stands still while it does.

    def token(self, user: str | None) -> str | None:
        signed_in = self.github.get(user) if user else None
        if signed_in and time.time() > signed_in["until"]:  # GitHub's tokens for the page last 8 hours
            self.github.pop(user, None)
            return None
        return signed_in and signed_in["token"]

    def github_state(self, user: str | None) -> dict:
        """Who reads GitHub for this person: their own sign-in, or the page's login."""
        device = self.devices.get(user) if user else None
        waiting = device and time.time() < device["until"]
        return {"sign_in": bool(GITHUB_CLIENT_ID and user),
                "login": self.github[user]["login"] if self.token(user) else None,
                **({"install": install_url()} if GITHUB_APP and self.token(user) else {}),
                # a sign-in still waiting for GitHub, so a reloaded page shows its code again
                **({"device": device["shown"]} if waiting else {})}

    def github_device(self, user: str | None) -> dict:
        """Start a sign-in: a code the person enters on GitHub, approving this page's read of the
        repositories they install the app on. A GitHub App takes no scope: its permissions are its own."""
        if not (GITHUB_CLIENT_ID and user):
            return {"error": "GitHub sign-in isn't set up on this page."}
        try:
            got = github_form("https://github.com/login/device/code", {"client_id": GITHUB_CLIENT_ID})
        except (OSError, ValueError) as exc:
            return {"error": f"GitHub didn't answer ({exc})."}
        if not got.get("device_code"):
            return {"error": got.get("error_description") or "GitHub refused to start a sign-in."}
        interval = int(got.get("interval") or 5)
        shown = {"user_code": got["user_code"], "verification_uri": got["verification_uri"], "interval": interval}
        self.devices[user] = {"code": got["device_code"], "interval": interval, "shown": shown,
                              "until": time.time() + int(got.get("expires_in") or 900)}
        return shown

    def github_poll(self, user: str | None) -> dict:
        """Whether the person has approved the sign-in yet; the page asks every few seconds."""
        device = self.devices.get(user) if user else None
        if not device or time.time() > device["until"]:
            self.devices.pop(user, None)
            return {"error": "The sign-in code expired. Start again."}
        try:
            got = github_form("https://github.com/login/oauth/access_token", {
                "client_id": GITHUB_CLIENT_ID, "device_code": device["code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
        except (OSError, ValueError):
            return {"pending": True, "interval": device["interval"]}  # asked again at the next poll
        if got.get("error") in ("authorization_pending", "slow_down"):
            if got["error"] == "slow_down":
                device["interval"] += 5
            return {"pending": True, "interval": device["interval"]}
        self.devices.pop(user, None)
        if not got.get("access_token"):
            return {"error": got.get("error_description") or "GitHub didn't sign you in."}
        try:
            login = tasks.gh("user", got["access_token"]).get("login")
        except (RuntimeError, SystemExit):
            login = None
        self.github[user] = {"token": got["access_token"], "login": login,
                             "until": time.time() + int(got.get("expires_in") or 8 * 3600) - 60}
        return {"login": login}

    def github_sign_out(self, user: str | None) -> dict:
        self.github.pop(user, None)
        self.devices.pop(user, None)
        return {"ok": True}

    # ---------- favorite pull requests ----------

    def favorites(self, user: str | None) -> list[dict]:
        """This person's saved pull requests, newest first."""
        return read_json(self.favorites_file).get(user or "local", [])

    def favorite(self, form: dict, user: str | None = None) -> dict:
        """Save a pull request for later, or forget it: {repo, number, title, saved}."""
        repo, number = parse_repo(str(form.get("repo") or "")), form.get("number")
        if not repo or not isinstance(number, int) or number < 1:
            return {"error": "A favorite is a repository and a pull request number."}
        with self.lock:
            everyone = read_json(self.favorites_file)
            same = (repo.lower(), number)  # GitHub names ignore case
            mine = [f for f in everyone.get(user or "local", []) if (f["repo"].lower(), f["number"]) != same]
            if form.get("saved"):
                mine.insert(0, {"repo": repo, "number": number, "title": str(form.get("title") or "")[:300],
                                "saved_at": pipeline.now()})
            everyone[user or "local"] = mine[:MAX_FAVORITES]
            self.favorites_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.favorites_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(everyone, indent=1))
            tmp.replace(self.favorites_file)
        return {"favorites": everyone[user or "local"]}


def install_url() -> str:
    """Where a person picks the repositories the GitHub App may read."""
    return f"https://github.com/apps/{GITHUB_APP}/installations/new"


def github_form(url: str, form: dict) -> dict:
    """POST a form to GitHub's sign-in endpoints and read the JSON answer."""
    request = urllib.request.Request(url, data=urlencode(form).encode(), headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:  # its answer still says why
        return json.loads(exc.read() or b"{}")


def again(meta: dict) -> dict | None:
    """What Run again puts back in the form: the run's pull requests (the ones its check kept, so a
    repository's latest merges stay the same PRs), its models and its commands."""
    request = meta.get("request") or {}
    models = [m["key"] for m in meta.get("models") or []]
    if request.get("quick"):
        return {"quick": True, "models": models}
    pulls: dict[str, list[int]] = {}
    for task_id in meta.get("tasks") or meta.get("candidates") or []:
        number = task_id.rsplit("-", 1)[-1]
        if number.isdigit():
            pulls.setdefault(repo_of(task_id), []).append(int(number))
    if not pulls or sum(map(len, pulls.values())) > MAX_LIMIT:
        return None
    return {"pulls": pulls, "setup": request.get("setup"), "test": request.get("test"), "models": models}


def cell(model: str, attempt: int, result: dict) -> dict:
    """A finished attempt on the board: its outcome, time, cost, and what the tests and judge said."""
    seconds = None
    if result.get("started_at") and result.get("finished_at"):
        seconds = round((datetime.fromisoformat(result["finished_at"])
                         - datetime.fromisoformat(result["started_at"])).total_seconds())
    return {"model": model, "attempt": attempt, "stage": result.get("outcome") or "invalid",
            "reason": result.get("invalid_reason"), "seconds": seconds,
            "cost": (result.get("agent") or {}).get("cost_usd"), "diff": result.get("diff"),
            "tests_passed": (result.get("tests") or {}).get("passed"),
            "judge": (result.get("judge") or {}).get("verdict")}


def read_json(path: Path) -> dict:
    """A run's JSON file, or {} if it isn't there or can't be read right now."""
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def usd(x: float) -> str:
    return f"${x:,.0f}" if x >= 100 else f"${x:.2f}"


def tail(path: Path, lines: int = 15) -> str | None:
    if not path.is_file():
        return None
    return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])


class Handler(http.server.SimpleHTTPRequestHandler):
    """The page and its small JSON API; anything else is a file under jobs/ (the reports)."""

    app: App

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.app.jobs_dir), **kwargs)

    def do_GET(self):
        url = urlsplit(self.path)
        if not self.same_origin():
            return self.send_error(403)
        if url.path in ("/", "/index.html"):
            return self.send_body(PAGE.read_bytes(), "text/html; charset=utf-8")
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        user = self.user()
        if url.path == "/api/state":
            return self.send_json(self.app.state(query.get("run", ""), user))
        if url.path == "/api/repo":
            return self.send_json(self.app.repo_info(query.get("name", ""), user))
        if url.path == "/api/prs":
            return self.send_json(self.app.pulls(query.get("repo", ""), query.get("numbers", ""), query.get("count", ""),
                                                 query.get("q", ""), user))
        if url.path == "/api/trace":
            return self.send_json(self.app.trace(query.get("run", ""), query.get("trial", ""), user))
        if (report := REPORT_FILE.fullmatch(url.path)) and self.app.visible(self.app.jobs_dir / report[1], user):
            return super().do_GET()
        return self.send_error(404)

    def do_POST(self):
        # Only this page may start or stop runs: they spend money. A JSON body from another
        # site needs a CORS preflight this server never answers, and the origin must be ours.
        if not self.same_origin() or self.headers.get("content-type", "").split(";")[0] != "application/json":
            return self.send_error(403)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self.send_error(400)
        path, user = urlsplit(self.path).path, self.user()
        if user:  # hosted: runs spend money, so the log says who started, stopped or resumed one
            print(f"[eval] {user} POST {path}", flush=True)
        if path == "/api/runs":
            return self.send_json(self.app.start(body, user))
        if match := re.fullmatch(r"/api/runs/([^/]+)/(stop|resume)", path):
            run_id, action = match.groups()
            return self.send_json(self.app.stop(run_id, user) if action == "stop" else self.app.resume(run_id, user))
        if path == "/api/favorites":
            return self.send_json(self.app.favorite(body, user))
        if path == "/api/github/device":
            return self.send_json(self.app.github_device(user))
        if path == "/api/github/poll":
            return self.send_json(self.app.github_poll(user))
        if path == "/api/github/sign-out":
            return self.send_json(self.app.github_sign_out(user))
        return self.send_error(404)

    def user(self) -> str | None:
        """Who is asking, as the hosted sign-in names them; locally, no one in particular."""
        return self.headers.get(USER_HEADER) or None

    def same_origin(self) -> bool:
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("origin")
        return self.headers.get("host") in allowed and (
            origin is None or urlsplit(origin).netloc in allowed or bool(APP_ORIGIN) and origin == APP_ORIGIN)

    def send_json(self, data: dict) -> None:
        self.send_body(json.dumps(data).encode(), "application/json", 400 if "error" in data else 200)

    def send_body(self, body: bytes, kind: str, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("content-type", kind)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # the page polls; keep the terminal quiet
        pass


def serve(jobs_dir: Path, port: int, open_browser: bool = True) -> None:
    jobs_dir.mkdir(parents=True, exist_ok=True)
    page = App(jobs_dir)
    # Check the workspace, the CLIs and the judge while the server starts, so the first visit doesn't wait.
    threading.Thread(target=lambda: page.checks(config.load(page.models_config)[1]), daemon=True).start()
    handler = type("BoundHandler", (Handler,), {"app": page})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"pr-eval at {url} (Ctrl-C to stop the page; runs keep going)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
