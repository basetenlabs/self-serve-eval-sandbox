"""pr-eval: replay merged PRs through Claude Code, closed model vs open model.

    pr-eval serve                       the local page: pick a repository and models, start, watch
    pr-eval run owner/repo              the same from the terminal: PRs -> check -> models -> report
    pr-eval run                         the sample tasks instead of a repository

(Not `eval`: that is a shell builtin, so a command by that name can never be called.)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import app, config, pipeline, report, runner, tasks


def csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def cmd_run(args) -> int:
    if args.resume:
        # A resumed run keeps its own tasks. --attempts may grow it and --models may add
        # models, so a new model is compared on the same tasks without rerunning the others.
        job = pipeline.Job(args.resume)
        keys, added = pipeline.resumed_models(job.meta, args.models)
        models, judge = pipeline.preflight(keys, args.judge, args.models_config)
        job.meta["models"] += [m.as_dict() for m in models if m.key in added]
        job.meta["attempts"] = max(args.attempts or 0, job.meta.get("attempts", 1))
        job.save()
    else:
        if args.pr and len(args.repos) != 1:
            sys.exit("--pr needs exactly one repository")
        models, judge = pipeline.preflight(args.models or pipeline.DEFAULT_MODELS, args.judge, args.models_config)
        request = pipeline.Request(repos=args.repos, prs=args.pr, limit=args.limit, since=args.since, setup=args.setup,
                                   test=args.test, language=args.language, max_lines=args.max_lines, task_ids=args.task)
        job = pipeline.new_job(request, models, judge, attempts=args.attempts or 1, name=args.name,
                               jobs_dir=args.jobs, image=args.image, tasks_dir=args.tasks)
    print(f"run {job.id} -> {job.path}")
    settings = runner.Settings(image=args.image, concurrency=args.concurrency, cpus=args.cpus, memory=args.memory,
                               agent_timeout=args.agent_timeout, judge=judge, keep_containers=args.keep_containers)
    return pipeline.execute(job, models, settings, skip_check=args.skip_validation)


def cmd_serve(args) -> int:
    app.serve(args.jobs, args.port, open_browser=not args.no_open)
    return 0


def cmd_collect(args) -> int:
    if args.pr and len(args.repos) != 1:
        sys.exit("--pr needs exactly one repository")
    wanted = {repo: args.pr for repo in args.repos} or tasks.sample()
    written = []
    for repo, prs in wanted.items():
        written += tasks.collect(repo, args.out, prs=prs, limit=args.limit, since=args.since, setup=args.setup,
                                 test=args.test, language=args.language, force=args.force, max_lines=args.max_lines)
    print(f"{len(written)} tasks in {args.out}")
    return 0 if written else 1


def cmd_validate(args) -> int:
    pipeline.ensure_image(args.image)
    selected = tasks.discover(args.tasks, args.task)
    settings = runner.Settings(image=args.image, concurrency=args.concurrency)
    counts: dict[str, int] = {}

    def checked(record, done, total):
        counts[record["status"]] = counts.get(record["status"], 0) + 1
        print(f"[{done}/{total}] {record['task_id']}: {record['status']}", flush=True)

    runner.in_parallel(selected, lambda t: runner.validate_task(t, settings), args.concurrency, "validate", checked)
    print(", ".join(f"{n} {status}" for status, n in sorted(counts.items())))
    return 0


def cmd_rejudge(args) -> int:
    _, judge = config.load(args.models_config)
    if args.judge:
        judge.model = args.judge
    if not judge.api_key:
        sys.exit(f"the judge needs {judge.api_key_env}")
    meta = json.loads((args.job / "run.json").read_text())
    tasks_dir = Path(meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
    changed = runner.rejudge(args.job, tasks_dir, judge, concurrency=args.concurrency, force=args.force)
    flips = [c for c in changed if c["before"] != c["after"]]
    for c in flips:
        print(f"{c['trial']}: {c['before']} -> {c['after']} ({c['reason']})")
    print(f"regraded {len(changed)} attempt(s) with {judge.model}; {len(flips)} changed outcome")
    print(report.build(args.job))
    return 0


def cmd_retest(args) -> int:
    pipeline.ensure_image(args.image)
    meta = json.loads((args.job / "run.json").read_text())
    tasks_dir = Path(meta.get("tasks_dir") or tasks.DEFAULT_TASKS)
    settings = runner.Settings(image=args.image, concurrency=args.concurrency)
    changed = []

    def retested(r, done, total):
        line = r.get("error") or f"{r['before']} -> {r['after']} (tests {r['tests']}, judge {r['judge']})"
        print(f"[{done}/{total}] {r['trial']}: {line}", flush=True)
        if r.get("before") != r.get("after") and not r.get("error"):
            changed.append(r)

    runner.retest(args.job, tasks_dir, settings, force=args.force, on_result=retested)
    print(f"{len(changed)} attempt(s) changed outcome")
    print(report.build(args.job))
    return 0


def cmd_report(args) -> int:
    for job in args.jobs:
        print(report.build(job))
    return 0


def cmd_build_image(args) -> int:
    return pipeline.build_image(args.image, args.claude_code_version)


def cmd_cleanup(args) -> int:
    removed = runner.cleanup(args.run_id)
    print(f"removed {len(removed)} container(s)")
    return 0


def add_task_options(p: argparse.ArgumentParser, limit_help: str) -> None:
    """Options that say which pull requests become tasks, shared by `run` and `collect`."""
    p.add_argument("repos", nargs="*", metavar="owner/repo",
                   help="GitHub repositories, public or private (none: the sample tasks)")
    p.add_argument("--limit", type=int, default=pipeline.DEFAULT_LIMIT, help=limit_help)
    p.add_argument("--pr", type=int, action="append", help="this PR number; repeatable (one repository)")
    p.add_argument("--since", help="only PRs merged on or after this date (YYYY-MM-DD)")
    p.add_argument("--setup", help="command that installs dependencies (Go and Python have a default)")
    p.add_argument("--test", help="command that runs the tests; {test_files} becomes the PR's changed test files")
    p.add_argument("--language", help="override the repository's language as GitHub reports it")
    p.add_argument("--max-lines", type=int, default=tasks.DEFAULT_MAX_LINES,
                   help=f"skip PRs that change more lines than this (default {tasks.DEFAULT_MAX_LINES})")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pr-eval", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="the local page: start runs and read their reports")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--no-open", action="store_true", help="don't open the page in a browser")
    s.add_argument("--jobs", type=Path, default=pipeline.DEFAULT_JOBS)
    s.set_defaults(func=cmd_serve)

    r = sub.add_parser("run", help="turn merged PRs into tasks, run each model on them, grade, report")
    add_task_options(r, f"how many merged PRs, per repository (default {pipeline.DEFAULT_LIMIT})")
    r.add_argument("--models", type=csv, help=f"comma-separated keys from configs/models.toml (default "
                   f"{','.join(pipeline.DEFAULT_MODELS)}; with --resume, models to add to the run)")
    r.add_argument("--attempts", type=int, help="attempts per task and model (default 1; on --resume, raises the run's count)")
    r.add_argument("--resume", type=Path, help="finish a stopped run in this job directory")
    r.add_argument("--name", help="run id (default: the repository's name and the time)")
    r.add_argument("--task", action="append", help="run exactly this task folder's id; repeatable")
    r.add_argument("--judge", default="default", help="'none' to score on tests only, or a judge model id")
    r.add_argument("--concurrency", type=int, default=4, help="attempts at once (default 4)")
    r.add_argument("--cpus", default="2", help="CPUs per container (default 2)")
    r.add_argument("--memory", default="4g", help="memory per container (default 4g)")
    r.add_argument("--agent-timeout", type=int, help="seconds per attempt (default 1800)")
    r.add_argument("--skip-validation", action="store_true", help="run tasks without checking them first")
    r.add_argument("--keep-containers", action="store_true", help="leave trial containers for debugging")
    r.add_argument("--models-config", type=Path, default=config.DEFAULT_MODELS)
    r.add_argument("--image", default=runner.DEFAULT_IMAGE)
    r.add_argument("--jobs", type=Path, default=pipeline.DEFAULT_JOBS)
    r.add_argument("--tasks", type=Path, default=tasks.DEFAULT_TASKS)
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("collect", help="only turn merged PRs into task folders, without running anything")
    add_task_options(c, f"most recent merged PRs to keep per repository (default {pipeline.DEFAULT_LIMIT})")
    c.add_argument("--out", type=Path, default=tasks.DEFAULT_TASKS)
    c.add_argument("--force", action="store_true", help="rewrite task folders that already exist")
    c.set_defaults(func=cmd_collect)

    rep = sub.add_parser("report", help="rebuild report.html and report.json for runs")
    rep.add_argument("jobs", nargs="+", type=Path)
    rep.set_defaults(func=cmd_report)

    v = sub.add_parser("validate", help="check task folders in the trial image without running a model")
    v.add_argument("--tasks", type=Path, default=tasks.DEFAULT_TASKS)
    v.add_argument("--task", action="append")
    v.add_argument("--concurrency", type=int, default=4)
    v.add_argument("--image", default=runner.DEFAULT_IMAGE)
    v.set_defaults(func=cmd_validate)

    j = sub.add_parser("rejudge", help="grade a finished run again (new judge model or prompt) without re-running agents")
    j.add_argument("job", type=Path)
    j.add_argument("--judge", help="judge model id (default from configs/models.toml)")
    j.add_argument("--force", action="store_true", help="also regrade attempts this judge already graded")
    j.add_argument("--concurrency", type=int, default=8)
    j.add_argument("--models-config", type=Path, default=config.DEFAULT_MODELS)
    j.set_defaults(func=cmd_rejudge)

    t = sub.add_parser("retest", help="rerun a finished run's hidden tests from its saved diffs, with each "
                       "attempt's own test changes set aside (no model calls)")
    t.add_argument("job", type=Path)
    t.add_argument("--concurrency", type=int, default=2)
    t.add_argument("--force", action="store_true", help="also attempts already retested")
    t.add_argument("--image", default=runner.DEFAULT_IMAGE)
    t.set_defaults(func=cmd_retest)

    k = sub.add_parser("cleanup", help="remove trial containers a killed run left behind")
    k.add_argument("--run-id")
    k.set_defaults(func=cmd_cleanup)

    b = sub.add_parser("build-image", help="rebuild the Docker image trials run in")
    b.add_argument("--image", default=runner.DEFAULT_IMAGE)
    b.add_argument("--claude-code-version", help="default: the version pinned in docker/Dockerfile")
    b.set_defaults(func=cmd_build_image)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
