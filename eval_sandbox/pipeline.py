"""One run, from a request to a report: find the PRs, check them, run the models, report.

`pr-eval run` and the local page both start runs through here. A run writes what it is
doing to `status` in its run.json, so the page can show it while it goes:

    collecting -> checking -> running -> done
                                      -> stopped (Ctrl-C or Stop; resume finishes it)
                                      -> failed  (with the reason)

Each PR's attempts start as soon as its own check passes, so a run is already running
attempts while it says "checking"; "running" means every check is done.
"""
from __future__ import annotations

import json
import os
import platform
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import config, report, runner, runtime, tasks

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
            tasks_dir: Path = tasks.DEFAULT_TASKS, workspace: str | None = None,
            region: str = "us-pdx-1") -> Job:
    workspace = workspace or runtime.workspace()
    run_id = name or default_name(request)
    path = jobs_dir / run_id
    if (path / "run.json").exists():
        raise SystemExit(f"{path} exists: pass --resume {path} to finish it, or choose another --name")
    path.mkdir(parents=True, exist_ok=True)  # the page makes it first, for the run's log
    runner.write_json(path / "run.json", {
        "run_id": run_id, "created_at": now(), "request": asdict(request), "harness": "claude-code",
        "harness_version": None, "backend": "blaxel", "workspace": workspace, "image": image, "region": region,
        "attempts": attempts, "models": [m.as_dict() for m in models],
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
    attempts = job.meta.get("attempts", 1)
    try:
        restore_execution(job.meta, settings)
        if job.meta.get("tasks") and job.meta.get("checked", True):  # resumed after the check: keep the same tasks
            selected = tasks.discover(tasks_dir, job.meta["tasks"])
            settings.image = prepare_image(job, settings.image)
            if not skip_check and len(check(job, selected, settings)) != len(selected):
                raise SystemExit("The original task set no longer passes validation; start a new run.")
            start_running(job, models, settings)
            runner.run(selected, models, attempts, job.path, settings, job.id, on_result=progress_printer(job))
        else:
            if job.meta.get("candidates"):  # resumed while checking: the same pull requests
                candidates = tasks.discover(tasks_dir, job.meta["candidates"])
            else:
                request = Request(**job.meta.get("request") or {})
                job.status("collecting", f"Finding merged pull requests in {request.describe()}")
                candidates = find_tasks(request, tasks_dir)
                if not candidates:
                    raise SystemExit(f"No merged pull requests in {request.describe()} change both code and tests.")
                job.meta["candidates"] = [t.id for t in candidates]
            settings.image = prepare_image(job, settings.image)
            if skip_check:
                job.meta.update(tasks=[t.id for t in candidates], checked=True)
                start_running(job, models, settings)
                runner.run(candidates, models, attempts, job.path, settings, job.id, on_result=progress_printer(job))
            else:
                check_and_run(job, candidates, models, settings)
        path = report.build(job.path)
        job.status("done", f"Finished. Report: {path}")
        return 0
    except KeyboardInterrupt:
        runner.cleanup(job.id, workspace=settings.workspace)
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


def start_running(job: Job, models: list[config.Model], settings: runner.Settings) -> None:
    note_harness_version(job, settings)
    attempts = job.meta.get("attempts", 1)
    job.status("running", f"Running {len(job.meta['tasks'])} tasks x {len(models)} models"
                          + (f" x {attempts} attempts" if attempts > 1 else ""))
    report.build(job.path)


def note_harness_version(job: Job, settings: runner.Settings) -> None:
    job.meta["harness_version"] = (job.meta.get("harness_version")
                                   or image_claude_version(settings.image, settings.region, job.id))


def check_and_run(job: Job, candidates: list[tasks.Task], models: list[config.Model],
                  settings: runner.Settings) -> None:
    """Check the pull requests, and run the models on each one as soon as it passes."""
    note_harness_version(job, settings)
    job.meta["checked"] = False
    job.meta.setdefault("tasks", [])
    job.status("checking", f"Checking {len(candidates)} pull requests: each PR's tests have to fail "
                           "before the change and pass after it. Attempts start on each one that passes.")
    report.build(job.path)
    statuses: dict[str, str] = {}

    def checked(task: tasks.Task, status: str, unchecked: int) -> None:
        statuses[task.id] = status
        print(f"  [{len(statuses)}/{len(candidates)}] {task.id}: {status}", flush=True)
        if status == "valid" and task.id not in job.meta["tasks"]:
            job.meta["tasks"].append(task.id)
        if unchecked:
            job.save()
            return
        job.meta["checked"] = True
        leave_out(job, statuses)
        if job.meta["tasks"]:
            attempts = job.meta.get("attempts", 1)
            job.status("running", f"All checked. Running {len(job.meta['tasks'])} tasks x {len(models)} models"
                                  + (f" x {attempts} attempts" if attempts > 1 else ""))
        else:
            job.save()

    runner.check_and_run(candidates, models, job.meta.get("attempts", 1), job.path, settings, job.id,
                         on_checked=checked, on_result=progress_printer(job))
    if not job.meta["tasks"]:
        raise SystemExit(f"None of the {len(candidates)} pull requests passed the check. "
                         "If installing failed, give the install and test commands (--setup, --test).")


def check(job: Job, candidates: list[tasks.Task], settings: runner.Settings) -> list[tasks.Task]:
    """Keep the tasks whose PR tests fail without the change and pass with it, in this image."""
    job.status("checking", f"Checking {len(candidates)} pull requests: each PR's tests have to fail "
                           "before the change and pass after it")

    def checked(record, done, total):
        print(f"  [{done}/{total}] {record['task_id']}: {record['status']}", flush=True)

    runner.validate_all(candidates, settings, job.id, on_result=checked)
    statuses = {t.id: runner.validation_status(t, settings) for t in candidates}
    kept = [t for t in candidates if statuses[t.id] == "valid"]
    leave_out(job, statuses)
    if not kept:
        raise SystemExit(f"None of the {len(candidates)} pull requests passed the check. "
                         "If installing failed, give the install and test commands (--setup, --test).")
    return kept


def leave_out(job: Job, statuses: dict[str, str | None]) -> None:
    job.meta["left_out"] = {t: s for t, s in statuses.items() if s != "valid"}
    if job.meta["left_out"]:
        print(f"leaving out {len(job.meta['left_out'])} task(s) that failed the check (a setup problem, "
              f"not a model's): {', '.join(job.meta['left_out'])}")


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


def restore_execution(meta: dict, settings: runner.Settings) -> None:
    """Keep resumed work in its original backend, workspace and image."""
    if meta.get("backend") != "blaxel" or not meta.get("workspace") or not meta.get("image"):
        raise SystemExit("This run predates the Blaxel backend; start a new run instead of resuming a Docker run.")
    if settings.workspace and settings.workspace != meta["workspace"]:
        raise SystemExit("The requested workspace differs from this run's recorded Blaxel workspace.")
    settings.workspace = meta["workspace"]
    settings.image = meta["image"]
    settings.region = meta.get("region", "us-pdx-1")
    os.environ["PR_EVAL_BLAXEL_WORKSPACE"] = settings.workspace


def build_image(image: str, claude_code_version: str | None = None) -> int:
    try:
        runtime.check_connection()
        return runtime.build_image(image, claude_code_version)
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc


def image_exists(image: str) -> bool:
    return runtime.image_exists(image)


def prepare_image(job: Job, image: str) -> str:
    ensure_image(image, job)
    resolved = runtime.resolve_image(image)
    job.meta.setdefault("image_source", image)
    job.meta["image"] = resolved
    job.save()
    return resolved


def ensure_image(image: str, job: Job | None = None) -> None:
    """Check the dedicated workspace and build the trial template remotely on first use."""
    try:
        runtime.check_connection()
        if not image_exists(image):
            detail = f"Building the Blaxel trial image {image} remotely (first run only, a few minutes)"
            if job:
                job.status("checking", detail)
            else:
                print(detail, flush=True)
            if build_image(image):
                raise SystemExit("Blaxel image build failed; see the output above")
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc


def image_claude_version(image: str, region: str = "us-pdx-1", run_id: str = "image-probe") -> str | None:
    return runtime.image_claude_version(image, region, run_id)


def resumed_models(meta: dict, requested: list[str] | None) -> tuple[list[str], list[str]]:
    """A resumed run's model keys plus any requested ones it doesn't have yet, and those new ones."""
    have = [m["key"] for m in meta["models"]]
    added = [k for k in requested or [] if k not in have]
    return have + added, added


def resumed_judge(meta: dict, choice: str) -> str:
    """The judge a resumed run started with, unless --judge names one, so a tests-only run stays tests only."""
    if choice != "default" or "judge" not in meta:
        return choice
    return meta["judge"]["model"] if meta["judge"] else "none"
