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
import shutil
import subprocess
import threading
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config, report, runner, runtime, tasks

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JOBS = ROOT / "jobs"
DEFAULT_MODELS = ["claude-opus", "deepseek-v4.1-flash"]
DEFAULT_LIMIT = 10
ACTIVE = ("collecting", "checking", "running")
# An attempt's transcript: the agent's log, its condensed trace, the model proxy's log and the prompt.
# A run on a private repository loses these PR_EVAL_PRIVATE_RETENTION_DAYS after it ends (unset: kept);
# its report and each attempt's result stay.
TRANSCRIPTS = ("agent.jsonl", "agent.stderr", "trace.json", "proxy.log", "prompt.md")

# Why a task was left out, in words: the check runs before any model, so none of these is a model's fault.
LEFT_OUT = {
    "non-discriminating": "its tests already pass without the change",
    "reference-fails": "its tests fail even with the merged change",
    "reference-apply-error": "the merged change doesn't apply",
    "setup-error": "installing dependencies failed",
    "setup-timeout": "installing dependencies timed out",
    "timeout": "its tests timed out",
    "workspace-error": "the code couldn't be unpacked",
    "request-misses-tests": "its tests need what its request never says",
}


@dataclass
class Request:
    """What a run covers: recent merged PRs from `repos`, exact ones from `pulls`, or the sample tasks."""
    repos: list[str] = field(default_factory=list)
    prs: list[int] | None = None  # these PRs of the one repository in `repos`
    pulls: dict[str, list[int]] = field(default_factory=dict)  # exactly these PRs, by repository
    limit: int | None = DEFAULT_LIMIT
    since: str | None = None
    setup: str | None = None
    test: str | None = None
    language: str | None = None
    max_lines: int = tasks.DEFAULT_MAX_LINES
    task_ids: list[str] | None = None  # exactly these task folders instead
    quick: bool = False  # the quick sample: every PR in configs/quick_tasks.toml

    def describe(self) -> str:
        if self.task_ids:
            return f"{len(self.task_ids)} chosen tasks"
        if self.repos or self.pulls:
            return ", ".join(self.named())
        return "the quick sample" if self.quick else "the sample tasks"

    def named(self) -> list[str]:
        return list(dict.fromkeys([*self.repos, *self.pulls]))


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
        if phase not in ACTIVE:  # while this run still reads as going, so no new run starts on files being deleted
            release_private(self)
        self.meta["status"] = {"phase": phase, "detail": detail, "pid": os.getpid(), "updated_at": now()}
        self.save()
        if detail:
            print(detail, flush=True)


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


def run_repos(meta: dict) -> list[str]:
    """The repositories a run names or has tasks from."""
    request = meta.get("request") or {}
    named = [*(request.get("repos") or []), *(request.get("pulls") or {})]
    ids = [*(meta.get("candidates") or []), *(meta.get("tasks") or []), *(request.get("task_ids") or [])]
    return list(dict.fromkeys([*named, *map(repo_of, ids)]))


def release_private(job: Job) -> None:
    """Delete what a finished, failed or stopped run kept of its private repositories: their bare
    clones and their task folders (source, merged diff, hidden tests). The run's report and results stay."""
    try:
        tasks_dir = Path(job.meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
        delete_private({repo: [clone_path(repo), *task_folders(repo, tasks_dir)] for repo in run_repos(job.meta)},
                       job.path.parent, job.path)
    except Exception as exc:  # noqa: BLE001 - a cleanup hiccup must not hide how the run ended
        print(f"(private repositories not cleaned up: {exc})", flush=True)


def sweep_private(jobs_dir: Path) -> None:
    """Delete every private clone and task folder no going run uses, such as ones left by a run whose
    process died (a crash, the page restarting) before it could clean up. `pr-eval serve` and `pr-eval run`
    sweep as they start; a starting run marks itself going first, so what it's about to use stays."""
    try:
        found: dict[str, list[Path]] = {}
        for path in tasks.DEFAULT_REPOS.glob("*__*.git"):
            found.setdefault(path.name.removesuffix(".git").replace("__", "/", 1).lower(), []).append(path)
        for path in tasks.DEFAULT_TASKS.glob("*__*-*"):
            if path.is_dir() and path.name.rsplit("-", 1)[-1].isdigit():
                found.setdefault(repo_of(path.name).lower(), []).append(path)
        delete_private(found, jobs_dir)
    except Exception as exc:  # noqa: BLE001 - a cleanup hiccup must not stop a run or the page
        print(f"(private repositories not cleaned up: {exc})", flush=True)
    try:
        expire_transcripts(jobs_dir)
    except Exception as exc:  # noqa: BLE001
        print(f"(transcripts not cleaned up: {exc})", flush=True)


def expire_transcripts(jobs_dir: Path) -> None:
    """Delete the transcripts of runs on private repositories that ended PR_EVAL_PRIVATE_RETENTION_DAYS
    ago or more. Unset keeps them. A repository GitHub won't confirm is public counts as private."""
    days = os.environ.get("PR_EVAL_PRIVATE_RETENTION_DAYS", "").strip()
    if not days:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=float(days))).isoformat(timespec="seconds")
    answers: dict[str, bool] = {}
    for path in jobs_dir.glob("*/run.json"):
        try:
            meta = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        status = meta.get("status") or {}
        if status.get("phase") in ACTIVE and alive(status.get("pid")):
            continue
        if (status.get("updated_at") or meta.get("created_at") or "") > cutoff:  # ISO times in UTC sort as text
            continue
        found = [f for name in TRANSCRIPTS for f in path.parent.glob(f"trials/*/{name}")]
        repos = run_repos(meta)
        if not found or not any(answers.setdefault(r.lower(), private(r)) for r in repos):
            continue
        for f in found:
            f.unlink(missing_ok=True)
        print(f"deleted {len(found)} transcript files of run {path.parent.name} on a private repository", flush=True)


def clone_path(repo: str) -> Path:
    return tasks.DEFAULT_REPOS / f"{repo.replace('/', '__')}.git"


def task_folders(repo: str, tasks_dir: Path) -> list[Path]:
    """The task folders collected from this repository, one per pull request."""
    prefix = repo.replace("/", "__")
    return [path for path in tasks_dir.glob(f"{prefix}-*") if path.is_dir()
            and path.name.rsplit("-", 1)[-1].isdigit() and repo_of(path.name).lower() == repo.lower()]


def busy_repos(jobs_dir: Path, skip: Path | None = None) -> set[str]:
    """The repositories, lowercased, of every run in jobs_dir that's still going, except `skip`'s."""
    busy: set[str] = set()
    for path in jobs_dir.glob("*/run.json"):
        if skip and path.parent.resolve() == skip.resolve():
            continue
        try:
            meta = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        status = meta.get("status") or {}
        if status.get("phase") in ACTIVE and alive(status.get("pid")):
            busy |= {repo.lower() for repo in run_repos(meta)}
    return busy


def delete_private(found: dict[str, list[Path]], jobs_dir: Path, skip: Path | None = None) -> None:
    """Delete these clones and task folders of private repositories, unless a going run uses the repository.

    Every run on this machine shares data/repos/ and tasks/, whoever started it, so a repository's
    files stay while any run on it is going. A repository GitHub won't confirm is public now counts
    as private: deleting a public one's files only costs collecting them again.
    """
    busy = busy_repos(jobs_dir, skip)
    found = {repo: paths for repo, paths in found.items()
             if any(path.is_dir() for path in paths) and repo.lower() not in busy and private(repo)}
    if found:  # look again: a run may have started while GitHub answered
        busy = busy_repos(jobs_dir, skip)
    for repo, paths in found.items():
        if repo.lower() not in busy:
            for path in paths:
                shutil.rmtree(path, ignore_errors=True)
            print(f"deleted the clone and task folders of private repository {repo}", flush=True)


def private(repo: str) -> bool:
    # The sample's repositories are public, as configured. Asking GitHub could fail (the hosted page's
    # anonymous requests hit its rate limit) and delete the quick sample's tasks, which then need a GitHub sign-in.
    if repo.lower() in {r.lower() for quick in (True, False) for r in tasks.sample(quick)}:
        return False
    try:
        return tasks.gh(f"repos/{repo}").get("private") is not False
    except (RuntimeError, SystemExit, ValueError):
        # The hosted page has no GitHub login: GitHub answers anyone for a public repository.
        return not public_to_anyone(repo)


def public_to_anyone(repo: str) -> bool:
    """Whether GitHub shows the repository to someone not signed in; any doubt reads as no."""
    try:
        with urllib.request.urlopen(urllib.request.Request(
                f"https://api.github.com/repos/{repo}", headers={"Accept": "application/vnd.github+json"}),
                timeout=20) as answer:
            return json.loads(answer.read()).get("private") is False
    except (OSError, ValueError):
        return False


def preflight(model_keys: list[str], judge_choice: str = "default",
              models_config: Path = config.DEFAULT_MODELS, *, judges_checked: bool = False,
              ) -> tuple[list[config.Model], config.Panel | None]:
    """The models and judges for a run, or SystemExit saying what is missing.

    `judge_choice` is "default" for the configured panel, "none" for tests only, or one
    judge's model id or label to grade with that judge alone. `judges_checked` doesn't ask the
    judges' providers again: the page checked them a moment before it started the run.
    """
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
        judge = judge.only(judge_choice)
    if not judges_checked and (problem := judge.problem()):
        raise SystemExit(problem)
    return models, judge


def new_job(request: Request, models: list[config.Model], judge: config.Panel | None, *, attempts: int = 1,
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
        "judge": judge.as_dict() if judge else None,
        "tasks": [], "tasks_dir": str(tasks_dir.resolve()), "host": platform.platform()})
    return Job(path)


def default_name(request: Request) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    named = request.named()
    return f"{named[0].split('/')[-1] if named else 'quick' if request.quick else 'sample'}-{stamp}"


def find_tasks(request: Request, tasks_dir: Path, on_progress=None) -> list[tasks.Task]:
    """Task folders for the request, collected from GitHub where they don't exist yet.
    `on_progress(text)` hears each step of collecting, with counts."""
    if request.task_ids:
        return tasks.discover(tasks_dir, request.task_ids)
    if request.repos or request.pulls:
        wanted = {repo: request.prs for repo in request.repos} | request.pulls
        paths = [path for repo, prs in wanted.items() for path in tasks.collect(
            repo, tasks_dir, prs=prs, limit=request.limit or DEFAULT_LIMIT, since=request.since,
            setup=request.setup, test=request.test, language=request.language, max_lines=request.max_lines,
            on_progress=on_progress)]
        return [tasks.load(p) for p in paths]
    paths = [path for repo, prs in tasks.sample(request.quick).items() for path in tasks.collect(repo, tasks_dir, prs=prs)]
    found = sorted((tasks.load(p) for p in paths), key=lambda t: t.meta["task"]["merged_at"])
    if request.quick or not request.limit:
        return found
    return tasks.spread(found, request.limit, repo=lambda t: t.meta["task"]["repo"])


def restore_tasks(ids: list[str], tasks_dir: Path, request: dict) -> list[tasks.Task]:
    """A resumed run's tasks, collected again where they were deleted with their private repository."""
    missing: dict[str, list[int]] = {}
    for task_id in ids:
        number = task_id.rsplit("-", 1)[-1]
        if "__" in task_id and number.isdigit() and not (tasks_dir / task_id / "task.toml").is_file():
            missing.setdefault(repo_of(task_id), []).append(int(number))
    for repo, prs in missing.items():
        tasks.collect(repo, tasks_dir, prs=prs, setup=request.get("setup"), test=request.get("test"),
                      language=request.get("language"))
    return tasks.discover(tasks_dir, ids)


def execute(job: Job, models: list[config.Model], settings: runner.Settings, *, skip_check: bool = False) -> int:
    """Take a new or resumed run as far as it can go. Returns the exit code."""
    tasks_dir = Path(job.meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
    attempts = job.meta.get("attempts", 1)
    asking = None
    try:
        restore_execution(job.meta, settings)
        if job.meta.get("tasks") and job.meta.get("checked", True):  # resumed after the check: keep the same tasks
            selected = restore_tasks(job.meta["tasks"], tasks_dir, job.meta.get("request") or {})
            settings.image = prepare_image(job, settings.image)
            asking = note_harness_version(job, settings)
            if not skip_check and len(check(job, selected, settings)) != len(selected):
                raise SystemExit("The original task set no longer passes validation; start a new run.")
            start_running(job, models, settings)
            runner.run(selected, models, attempts, job.path, settings, job.id, on_result=progress_printer(job))
        else:
            if job.meta.get("candidates"):  # resumed while checking: the same pull requests
                candidates = restore_tasks(job.meta["candidates"], tasks_dir, job.meta.get("request") or {})
            else:
                request = Request(**job.meta.get("request") or {})
                job.status("collecting", f"Finding merged pull requests in {request.describe()}")
                candidates = find_tasks(request, tasks_dir, on_progress=collecting(job))
                if not candidates:
                    raise SystemExit(f"No merged pull requests in {request.describe()} change both code and tests.")
                job.meta["candidates"] = [t.id for t in candidates]
            settings.image = prepare_image(job, settings.image)
            asking = note_harness_version(job, settings)
            if skip_check:
                job.meta.update(tasks=[t.id for t in candidates], checked=True)
                start_running(job, models, settings)
                runner.run(candidates, models, attempts, job.path, settings, job.id, on_result=progress_printer(job))
            else:
                check_and_run(job, candidates, models, settings)
        if asking:
            asking.join(120)
            job.save()
        path = report.build(job.path)
        lost = runner.lost_trials(job.path)
        job.status("done", f"Finished. Report: {path}" + (
            f". {lost} attempt(s) were lost to sandbox, setup or provider problems, not the models; "
            f"run them again with: pr-eval run --resume {job.path}" if lost else ""))
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
    finally:
        if asking:  # it deletes its sandbox when it's done, however the run ended
            asking.join(120)


def collecting(job: Job):
    """Shows each step of collecting on the page as it goes ("Cloning o/r: receiving objects 45%").
    A new step is saved at once; updates within a step at most once a second."""
    last, lock = ("", 0.0), threading.Lock()

    def tell(text: str) -> None:
        nonlocal last
        step = text.split(":", 1)[0]
        with lock:
            if step == last[0] and time.monotonic() - last[1] < 1:
                return
            last = (step, time.monotonic())
            job.meta["status"] = {**job.meta["status"], "detail": text, "updated_at": now()}
            job.save()

    return tell


def start_running(job: Job, models: list[config.Model], settings: runner.Settings) -> None:
    attempts = job.meta.get("attempts", 1)
    job.status("running", f"Running {len(job.meta['tasks'])} tasks x {len(models)} models"
                          + (f" x {attempts} attempts" if attempts > 1 else ""))
    report.build(job.path)


def note_harness_version(job: Job, settings: runner.Settings) -> threading.Thread | None:
    """The image's Claude Code version, for the report. An image's tag names its contents, so an earlier
    run on it knows the version; otherwise a sandbox asks the image beside the run's own work, so the
    first check doesn't wait for one. Join the thread this returns before building the final report."""
    if job.meta.get("harness_version"):
        return None
    if known := earlier_harness_version(job.path.parent, settings.image):
        job.meta["harness_version"] = known
        return None
    job.meta.setdefault("harness_version", None)  # saving meanwhile never sees the keys change
    asking = threading.Thread(target=lambda: job.meta.update(
        harness_version=image_claude_version(settings.image, settings.region, job.id)), daemon=True)
    asking.start()
    return asking


def earlier_harness_version(jobs_dir: Path, image: str) -> str | None:
    for path in jobs_dir.glob("*/run.json"):
        try:
            meta = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if meta.get("image") == image and meta.get("harness_version"):
            return meta["harness_version"]
    return None


def check_and_run(job: Job, candidates: list[tasks.Task], models: list[config.Model],
                  settings: runner.Settings) -> None:
    """Check the pull requests, and run the models on each one as soon as it passes."""
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
    # A resumed run checks only the tasks it kept, so the ones left out before stay left out.
    earlier = {t: s for t, s in job.meta.get("left_out", {}).items() if t not in statuses}
    job.meta["left_out"] = earlier | {t: s for t, s in statuses.items() if s != "valid"}
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
    """Keep resumed work in its original backend, workspace, image and sandbox size."""
    if meta.get("backend") != "blaxel" or not meta.get("workspace") or not meta.get("image"):
        raise SystemExit("This run predates the Blaxel backend; start a new run instead of resuming a Docker run.")
    if settings.workspace and settings.workspace != meta["workspace"]:
        raise SystemExit("The requested workspace differs from this run's recorded Blaxel workspace.")
    settings.workspace = meta["workspace"]
    settings.image = meta["image"]
    settings.region = meta.get("region", "us-pdx-1")
    # Disk grows with memory, so a resume never shrinks the run's sandboxes; a larger --memory raises them.
    settings.memory = meta["memory"] = max(settings.memory, meta.get("memory", 0))
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
    judge = meta["judge"]
    if not judge:
        return "none"
    if "panel" not in judge:  # a run from before judge panels: its single judge
        return judge["model"]
    return "default" if judge.get("chair") else judge["panel"][0]["model"]
