"""The local page: pick a repository and models, start a run, watch it, open its report.

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
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import config, pipeline, runner, tasks

PAGE = Path(__file__).with_name("app.html")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RUN_ID = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")  # never "." or ".."
MAX_LIMIT = 50


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
        self.lock = threading.Lock()
        self.checked: tuple[float, dict] = (0.0, {})

    # ---------- what the page shows ----------

    def state(self) -> dict:
        for child in list(self.children.values()):
            child.poll()
        catalog, judge = config.load(self.models_config)
        runs = [r for d in self.jobs_dir.iterdir() if d.is_dir() and (r := self.describe(d))] \
            if self.jobs_dir.is_dir() else []
        runs.sort(key=lambda r: r["active_at"], reverse=True)
        estimates = self.estimates(runs)
        models = [{"key": m.key, "label": m.label, "kind": m.kind, "provider": m.provider,
                   "missing": config.missing_credential(m), "default": m.key in pipeline.DEFAULT_MODELS,
                   **estimates.get(m.key, {})} for m in catalog.values()]
        return {"checks": self.checks(judge), "models": models, "runs": runs,
                "sample": {"tasks": sum(map(len, tasks.sample().values())), "repos": len(tasks.sample())},
                "default_limit": pipeline.DEFAULT_LIMIT, "max_limit": MAX_LIMIT,
                "busy": any(r["phase"] in pipeline.ACTIVE for r in runs)}

    def checks(self, judge: config.Judge) -> dict:
        """Docker, GitHub and the judge's key; cached briefly, since `docker info` is slow."""
        when, cached = self.checked
        if time.monotonic() - when > 15:
            docker = pipeline.docker_running()
            gh = bool(shutil.which("gh")) and subprocess.run(["gh", "auth", "status"], capture_output=True).returncode == 0
            cached = {"docker": docker, "gh": gh, "image": docker and pipeline.image_exists(runner.DEFAULT_IMAGE)}
            self.checked = (time.monotonic(), cached)
            cached["judge"] = judge.problem()
        return {**cached, "judge": {"model": judge.model, "env": judge.api_key_env, "ok": not cached["judge"],
                                    "problem": cached["judge"]}}

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
                    "left_out": [], "summary": {}, "report": None, "resumable": False,
                    "log": None if starting else tail(log)}
        meta = json.loads((job_dir / "run.json").read_text())
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
        if request.get("repos"):
            title = ", ".join(request["repos"])
        elif (run_tasks and set(run_tasks) <= sample) or (request and not request.get("task_ids")):
            title = "Sample tasks"
        else:
            title = repos[0] if len(repos) == 1 else f"{len(run_tasks)} tasks from {len(repos)} repositories"
        summary = {}
        report_json = job_dir / "report.json"
        if report_json.is_file():
            data = json.loads(report_json.read_text())
            last += [t.get("finished_at") or "" for t in data["trials"]]
            summary = {m["key"]: {k: data["summary"][m["key"]].get(k) for k in
                                  ("pass_at_1", "solved", "valid", "cost_per_solved", "invalid")}
                       for m in data["models"] if m["key"] in data["summary"]}
        candidates = meta.get("candidates") or []
        tasks_dir = Path(meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
        return {
            "id": job_dir.name, "title": title, "started": meta.get("created_at"), "tasks": len(run_tasks),
            "active_at": max(last),  # ISO times in UTC sort as text
            "models": [{"key": m["key"], "label": m["label"], "kind": m.get("kind")} for m in models],
            "phase": phase, "detail": detail, "note": meta.get("note"),
            "progress": {"done": done, "total": total},
            "checking": {"done": sum((tasks_dir / c / "validation" / "result.json").is_file() for c in candidates),
                         "total": len(candidates)},
            "left_out": [{"id": t, "pr": t.rsplit("-", 1)[-1], "why": pipeline.LEFT_OUT.get(s, s)}
                         for t, s in (meta.get("left_out") or {}).items()],
            "summary": summary, "report": f"{job_dir.name}/report.html" if (job_dir / "report.html").is_file() else None,
            "log": tail(log) if phase in ("failed", "stopped") else None,
            "resumable": phase in ("stopped", "failed") and bool(meta.get("request") or run_tasks),
        }

    def estimates(self, runs: list[dict]) -> dict[str, dict]:
        """Cost and time per attempt for each model, from the most recent run that has them."""
        found: dict[str, dict] = {}
        for run in runs:  # newest first
            path = self.jobs_dir / run["id"] / "report.json"
            if not path.is_file():
                continue
            for key, s in json.loads(path.read_text())["summary"].items():
                if key not in found and s.get("valid") and s.get("cost_per_attempt") is not None:
                    found[key] = {"cost_per_attempt": s["cost_per_attempt"], "seconds_per_attempt": s["median_seconds"]}
        return found

    def repo_info(self, text: str) -> dict:
        repo = parse_repo(text)
        if not repo:
            return {"error": "Use owner/repo or a GitHub link."}
        try:
            data = tasks.gh(f"repos/{repo}")
        except (RuntimeError, SystemExit) as exc:
            return {"repo": repo, "error": f"Can't read {repo} with your GitHub login ({str(exc)[-80:]})."}
        language = data.get("language") or "unknown"
        try:
            tasks.recipe(repo, language, [])
            defaults = True
        except tasks.Skip:
            defaults = False
        return {"repo": repo, "language": language, "private": data.get("private"), "defaults": defaults}

    # ---------- what the page does ----------

    def start(self, form: dict) -> dict:
        state = self.state()
        if state["busy"]:
            return {"error": "A run is already going. Let it finish, or stop it, before starting another."}
        checks = state["checks"]
        if not checks["docker"]:
            return {"error": "Docker isn't running. Start Docker Desktop, or run: colima start --cpu 8 --memory 12"}
        sample = bool(form.get("sample"))
        repo = None if sample else parse_repo(str(form.get("repo") or ""))
        if not sample and not repo:
            return {"error": "Enter a GitHub repository as owner/repo, or choose the sample tasks."}
        if not sample and not checks["gh"]:
            return {"error": "Sign in to GitHub first: run `gh auth login` in a terminal."}
        keys = [k for k in form.get("models") or [] if isinstance(k, str)]
        if not keys:
            return {"error": "Choose at least one model."}
        try:
            pipeline.preflight(keys, "default", self.models_config)
        except SystemExit as exc:
            return {"error": str(exc.code)}
        try:
            limit = int(form.get("limit") or pipeline.DEFAULT_LIMIT)
        except ValueError:
            return {"error": "The number of pull requests has to be a number."}
        if not 1 <= limit <= MAX_LIMIT:
            return {"error": f"Choose between 1 and {MAX_LIMIT} pull requests."}
        setup, test = (str(form.get(k) or "").strip()[:500] or None for k in ("setup", "test"))
        if repo and not (setup and test):
            info = self.repo_info(repo)
            if info.get("error"):
                return info
            if not info["defaults"]:
                return {"error": f"{repo} is {info['language']}: give the install and test commands "
                                 "(Go and Python repositories have defaults)."}
        run_id = f"{repo.split('/')[-1] if repo else 'sample'}-{datetime.now():%Y%m%d-%H%M%S}"
        argv = [repo] if repo else []
        argv += ["--limit", str(limit), "--models", ",".join(keys), "--name", run_id]
        argv += ["--setup", setup] if setup else []
        argv += ["--test", test] if test else []
        self.spawn(run_id, argv)
        return {"id": run_id}

    def stop(self, run_id: str) -> dict:
        run = self.find(run_id)
        if not run or run["phase"] not in pipeline.ACTIVE:
            return {"error": "That run isn't going."}
        meta = json.loads((self.jobs_dir / run_id / "run.json").read_text())
        pid = (meta.get("status") or {}).get("pid")
        if not alive(pid):
            return {"error": "That run's process has already ended."}
        os.kill(pid, signal.SIGINT)  # the run removes its containers and marks itself stopped
        return {"ok": True}

    def resume(self, run_id: str) -> dict:
        run = self.find(run_id)
        if not run or not run["resumable"]:
            return {"error": "That run can't be resumed."}
        if self.state()["busy"]:
            return {"error": "A run is already going. Let it finish, or stop it, first."}
        self.spawn(run_id, ["--resume", str(self.jobs_dir / run_id)])
        return {"id": run_id}

    def find(self, run_id: str) -> dict | None:
        path = self.jobs_dir / run_id
        return self.describe(path) if RUN_ID.fullmatch(run_id) and path.is_dir() else None

    def spawn(self, run_id: str, argv: list[str]) -> None:
        """`pr-eval run` in a process of its own, so it outlives the page and the server."""
        with self.lock:
            job_dir = self.jobs_dir / run_id
            job_dir.mkdir(parents=True, exist_ok=True)
            with open(job_dir / "log.txt", "ab") as log:
                self.children[run_id] = subprocess.Popen(
                    [sys.executable, "-m", "eval_sandbox", "run", *argv], cwd=pipeline.ROOT,
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)



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
        if url.path == "/api/state":
            return self.send_json(self.app.state())
        if url.path == "/api/repo":
            return self.send_json(self.app.repo_info(parse_qs(url.query).get("name", [""])[0]))
        return super().do_GET()

    def do_POST(self):
        # Only this page may start or stop runs: they spend money. A JSON body from another
        # site needs a CORS preflight this server never answers, and the origin must be ours.
        if not self.same_origin() or self.headers.get("content-type", "").split(";")[0] != "application/json":
            return self.send_error(403)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self.send_error(400)
        path = urlsplit(self.path).path
        if path == "/api/runs":
            return self.send_json(self.app.start(body))
        if match := re.fullmatch(r"/api/runs/([^/]+)/(stop|resume)", path):
            run_id, action = match.groups()
            return self.send_json(self.app.stop(run_id) if action == "stop" else self.app.resume(run_id))
        return self.send_error(404)

    def same_origin(self) -> bool:
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("origin")
        return self.headers.get("host") in allowed and (origin is None or urlsplit(origin).netloc in allowed)

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
    handler = type("BoundHandler", (Handler,), {"app": App(jobs_dir)})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"pr-eval at {url} (Ctrl-C to stop the page; runs keep going)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
