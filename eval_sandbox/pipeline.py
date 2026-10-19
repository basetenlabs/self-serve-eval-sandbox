"""One run, from a request to a report: find the PRs, check them, run the models, report.

`pr-eval run` and the local page both start runs through here. A run writes what it is
doing to `status` in its run.json, so the page can show it while it goes:

    collecting -> checking -> running -> done
                                      -> stopped (Ctrl-C or Stop; resume finishes it)
                                      -> failed  (with the reason)
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import config, report, runner, tasks

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JOBS = ROOT / "jobs"
DEFAULT_MODELS = ["claude-opus", "deepseek-v4.1-flash"]
DEFAULT_LIMIT = 10
ACTIVE = ("collecting", "checking", "running")

# Why a task was left out, in words: the check runs before any model, so none of these is a model's fault.
LEFT_OUT = {
    "non-discriminating": "its tests already pass without the change",
    "reference-fails": "its tests fail even with the merged change",
    "reference-apply-error": "the merged change doesn't apply",
    "setup-error": "installing dependencies failed",
    "setup-timeout": "installing dependencies timed out",
    "timeout": "its tests timed out",
    "workspace-error": "the code couldn't be unpacked",
}


@dataclass
class Request:
    """What a run covers: recent merged PRs from `repos`, or the sample tasks when empty."""
    repos: list[str] = field(default_factory=list)
    prs: list[int] | None = None
    limit: int | None = DEFAULT_LIMIT
    since: str | None = None
    setup: str | None = None
    test: str | None = None
    language: str | None = None
    max_lines: int = tasks.DEFAULT_MAX_LINES
    task_ids: list[str] | None = None  # exactly these task folders instead

    def describe(self) -> str:
        if self.task_ids:
            return f"{len(self.task_ids)} chosen tasks"
        if self.repos:
            return ", ".join(self.repos)
        return "the sample tasks"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Job:
    """A run's folder under jobs/, and its run.json."""

    def __init__(self, path: Path):
        self.path = path
        self.meta = json.loads((path / "run.json").read_text())

    @property
    def id(self) -> str:
        return self.meta["run_id"]

    def save(self) -> None:
        runner.write_json(self.path / "run.json", self.meta)

    def status(self, phase: str, detail: str = "") -> None:
        self.meta["status"] = {"phase": phase, "detail": detail, "pid": os.getpid(), "updated_at": now()}
        self.save()
        if detail:
            print(detail, flush=True)


def preflight(model_keys: list[str], judge_choice: str = "default",
              models_config: Path = config.DEFAULT_MODELS) -> tuple[list[config.Model], config.Judge | None]:
    """The models and judge for a run, or SystemExit saying what is missing."""
    catalog, judge = config.load(models_config)
    unknown = [k for k in model_keys if k not in catalog]
    if unknown:
        raise SystemExit(f"unknown model(s) {', '.join(unknown)}; {models_config.name} has: {', '.join(catalog)}")
    models = [catalog[k] for k in model_keys]
    for model in models:
        config.credential_env(model)  # fail now, not inside every container
    if judge_choice == "none":
        return models, None
    if judge_choice != "default":
        judge.model = judge_choice
    if problem := judge.problem():
        raise SystemExit(problem)
    return models, judge


def new_job(request: Request, models: list[config.Model], judge: config.Judge | None, *, attempts: int = 1,
            name: str | None = None, jobs_dir: Path = DEFAULT_JOBS, image: str = runner.DEFAULT_IMAGE,
            tasks_dir: Path = tasks.DEFAULT_TASKS) -> Job:
    run_id = name or default_name(request)
    path = jobs_dir / run_id
    if (path / "run.json").exists():
        raise SystemExit(f"{path} exists: pass --resume {path} to finish it, or choose another --name")
    path.mkdir(parents=True, exist_ok=True)  # the page makes it first, for the run's log
    runner.write_json(path / "run.json", {
        "run_id": run_id, "created_at": now(), "request": asdict(request), "harness": "claude-code",
        "harness_version": None, "image": image, "attempts": attempts, "models": [m.as_dict() for m in models],
        "judge": {"model": judge.model, "base_url": judge.base_url} if judge else None,
        "tasks": [], "tasks_dir": str(tasks_dir.resolve()), "host": platform.platform()})
    return Job(path)


def default_name(request: Request) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{request.repos[0].split('/')[-1] if request.repos else 'sample'}-{stamp}"


def find_tasks(request: Request, tasks_dir: Path) -> list[tasks.Task]:
    """Task folders for the request, collected from GitHub where they don't exist yet."""
    if request.task_ids:
        return tasks.discover(tasks_dir, request.task_ids)
    if request.repos:
        paths = [path for repo in request.repos for path in tasks.collect(
            repo, tasks_dir, prs=request.prs, limit=request.limit or DEFAULT_LIMIT, since=request.since,
            setup=request.setup, test=request.test, language=request.language, max_lines=request.max_lines)]
        return [tasks.load(p) for p in paths]
    paths = [path for repo, prs in tasks.sample().items() for path in tasks.collect(repo, tasks_dir, prs=prs)]
    found = sorted((tasks.load(p) for p in paths), key=lambda t: t.meta["task"]["merged_at"])
    return tasks.spread(found, request.limit, repo=lambda t: t.meta["task"]["repo"]) if request.limit else found


def execute(job: Job, models: list[config.Model], settings: runner.Settings, *, skip_check: bool = False) -> int:
    """Take a new or resumed run as far as it can go. Returns the exit code."""
    tasks_dir = Path(job.meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
    try:
        if job.meta.get("tasks"):  # resumed after the check: keep the same tasks
            selected = tasks.discover(tasks_dir, job.meta["tasks"])
            ensure_image(settings.image)
        else:
            request = Request(**job.meta.get("request") or {})
            job.status("collecting", f"Finding merged pull requests in {request.describe()}")
            candidates = find_tasks(request, tasks_dir)
            if not candidates:
                raise SystemExit(f"No merged pull requests in {request.describe()} change both code and tests.")
            job.meta["candidates"] = [t.id for t in candidates]
            ensure_image(settings.image)
            selected = candidates if skip_check else check(job, candidates, settings)
            job.meta["tasks"] = [t.id for t in selected]
        job.meta["harness_version"] = job.meta.get("harness_version") or image_claude_version(settings.image)
        attempts = job.meta.get("attempts", 1)
        job.status("running", f"Running {len(selected)} tasks x {len(models)} models"
                              + (f" x {attempts} attempts" if attempts > 1 else ""))
        report.build(job.path)
        runner.run(selected, models, attempts, job.path, settings, job.id, on_result=progress_printer(job))
        path = report.build(job.path)
        job.status("done", f"Finished. Report: {path}")
        return 0
    except KeyboardInterrupt:
        runner.cleanup(job.id)
        job.status("stopped", "Stopped. Resume to finish the attempts that hadn't finished: "
                              f"pr-eval run --resume {job.path}")
        rebuild_quietly(job)
        return 130
    except SystemExit as exc:
        job.status("failed", str(exc.code))
        raise
    except Exception as exc:
        job.status("failed", f"{type(exc).__name__}: {exc}")
        raise


def check(job: Job, candidates: list[tasks.Task], settings: runner.Settings) -> list[tasks.Task]:
    """Keep the tasks whose PR tests fail without the change and pass with it, in this image."""
    job.status("checking", f"Checking {len(candidates)} pull requests: each PR's tests have to fail "
                           "before the change and pass after it")

    def checked(record, done, total):
        print(f"  [{done}/{total}] {record['task_id']}: {record['status']}", flush=True)

    runner.validate_all(candidates, settings, job.id, on_result=checked)
    kept = [t for t in candidates if runner.validation_status(t) == "valid"]
    job.meta["left_out"] = {t.id: runner.validation_status(t) for t in candidates if t not in kept}
    if job.meta["left_out"]:
        print(f"leaving out {len(job.meta['left_out'])} task(s) that failed the check (a setup problem, "
              f"not a model's): {', '.join(job.meta['left_out'])}")
    if not kept:
        raise SystemExit(f"None of the {len(candidates)} pull requests passed the check. "
                         "If installing failed, give the install and test commands (--setup, --test).")
    return kept


def progress_printer(job: Job):
    """One line per finished attempt, and the report rebuilt every half minute."""
    last_build = time.monotonic()

    def progress(result: dict, done: int, total: int) -> None:
        nonlocal last_build
        cost = (result.get("agent") or {}).get("cost_usd")
        reason = f" ({result['invalid_reason']})" if result.get("invalid_reason") else ""
        print(f"[{done}/{total}] {result['trial']}: {result['outcome']}{reason}"
              + (f" ${cost:.3f}" if cost is not None else ""), flush=True)
        if time.monotonic() - last_build > 30:
            last_build = time.monotonic()
            rebuild_quietly(job)

    return progress


def rebuild_quietly(job: Job) -> None:
    try:
        report.build(job.path)
    except Exception as exc:  # noqa: BLE001 - a report hiccup must not stop the run
        print(f"(report not rebuilt: {exc})")


def build_image(image: str, claude_code_version: str | None = None) -> int:
    argv = ["docker", "build", "-t", image]
    if claude_code_version:
        argv += ["--build-arg", f"CLAUDE_CODE_VERSION={claude_code_version}"]
    return subprocess.run([*argv, str(ROOT / "docker")]).returncode


def docker_running() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def image_exists(image: str) -> bool:
    return subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0


def ensure_image(image: str) -> None:
    """Fail early and plainly without Docker, and build the trial image on first use."""
    if not docker_running():
        raise SystemExit("Docker isn't running. Start Docker Desktop, or `colima start --cpu 8 --memory 12`.")
    if not image_exists(image):
        print(f"building the trial image {image} (first run only, a few minutes)", flush=True)
        if build_image(image):
            raise SystemExit("docker build failed; see the output above")


def image_claude_version(image: str) -> str | None:
    try:
        out = subprocess.run(["docker", "run", "--rm", image, "claude", "--version"],
                             capture_output=True, timeout=120, check=True).stdout.decode()
        return out.split()[0]
    except (subprocess.SubprocessError, OSError, IndexError):
        return None


def resumed_models(meta: dict, requested: list[str] | None) -> tuple[list[str], list[str]]:
    """A resumed run's model keys plus any requested ones it doesn't have yet, and those new ones."""
    have = [m["key"] for m in meta["models"]]
    added = [k for k in requested or [] if k not in have]
    return have + added, added
