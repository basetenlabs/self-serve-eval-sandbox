"""Turn merged pull requests into self-contained task folders.

A task folder is what one trial needs and nothing more:

    tasks/<id>/
      task.toml                  metadata, setup and test commands, timeouts
      instruction.md             what the agent is asked to do (PR or linked-issue text)
      environment/source.tar     the repository at the PR's base commit, no .git
      tests/files/...            the PR's test files at the merged commit   (hidden)
      tests/deleted.txt          test files the PR removed                  (hidden)
      tests/test.sh              runs the hidden tests, Harbor-style reward  (hidden)
      solution/reference.patch   the merged diff, for the judge             (hidden)

Only `environment/` and `instruction.md` ever reach the agent. The rest is copied into
the trial container after the agent has finished.

Pull requests come from GitHub through the `gh` CLI, so private repositories work with
whatever access `gh auth login` gave. Each repository is cloned once, bare, into
data/repos/; the clone never enters a trial container.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TASKS = ROOT / "tasks"
DEFAULT_REPOS = ROOT / "data" / "repos"
SAMPLE = ROOT / "configs" / "sample_tasks.toml"

# A PR makes a good task when it changes code and tests together and is a reviewable size.
MAX_FILES, MAX_LINES, MAX_PATCH_BYTES, MIN_REQUEST_CHARS = 40, 1600, 400_000, 80
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|testing|fixtures)(/|$)"
                       r"|(?:_test\.go|[._](?:test|spec)\.[cm]?[jt]sx?|^test_[^/]+\.py|/test_[^/]+\.py)$", re.I)
SOURCE_FILE = re.compile(r"\.(?:py|go|[cm]?[jt]sx?|rs|c|cpp|h|java|rb|php)$", re.I)
MAINTENANCE = re.compile(r"\b(bump|dependabot|renovate|release|changelog|typo|readme|ci|workflow|pre-commit|"
                         r"formatting|linting|translations?)\b", re.I)
CLOSES_ISSUE = re.compile(r"\b(?:fix(?:es|ed)?|clos(?:e[sd]?|ing)|resolv(?:e[sd]?|ing))\s+"
                          r"(?:(?:https://github.com/([^/\s]+/[^/\s]+)/issues/)|(?:(\w[\w.-]*/[\w.-]+))?#)(\d+)", re.I)


@dataclass
class Task:
    id: str
    path: Path
    meta: dict
    instruction: str


class Skip(Exception):
    """A pull request that can't be a task, and why."""


def recipe(repo: str, language: str, test_paths: list[str], package_json: dict | None = None) -> dict:
    """Default setup and test commands for a repository; `--setup` and `--test` override them.

    The tests run are the repository's default suite, except where that suite needs more
    than one container (Hono: only the PR's changed test files).
    """
    if language == "Go":
        return {"setup": "go mod download && go build ./... >/dev/null",
                "test": "go test -count=1 -timeout=300s ./...",
                "scope": "repository default suite"}
    if language == "Python":
        return {"setup": ("uv venv --quiet --python 3.12 /opt/venv && "
                          "uv pip install --quiet --python /opt/venv/bin/python -e . pytest packaging"),
                "test": "PYTHONPATH=src:. python -m pytest -q --tb=short -p no:cacheprovider",
                "scope": "repository default suite"}
    if repo == "honojs/hono":
        manager = (package_json or {}).get("packageManager", "")
        pnpm = f"corepack {manager}" if re.fullmatch(r"pnpm@\d+\.\d+\.\d+", manager) else "corepack pnpm"
        files = [p for p in test_paths if re.search(r"\.test\.tsx?$", p) and p.startswith("src/")]
        return {"setup": f"{pnpm} install --frozen-lockfile --ignore-scripts",
                "test": ("node_modules/.bin/vitest run --project main --coverage.enabled=false "
                         + " ".join(shlex.quote(p) for p in files)),
                "scope": "the PR's changed test files"}
    raise Skip(f"no default setup and test commands for {language}; pass --setup and --test")


def toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    return json.dumps(str(value))  # a JSON string is a valid TOML basic string


def write_toml(path: Path, sections: dict[str, dict]) -> None:
    lines = []
    for name, values in sections.items():
        lines.append(f"[{name}]")
        lines += [f"{key} = {toml_value(value)}" for key, value in values.items() if value is not None]
        lines.append("")
    path.write_text("\n".join(lines))


def gh(endpoint: str):
    """One GitHub API call through the gh CLI, which carries the user's own login."""
    if not shutil.which("gh"):
        raise SystemExit("pr-eval collect reads pull requests with the GitHub CLI: install gh, then `gh auth login`.")
    p = subprocess.run(["gh", "api", endpoint], capture_output=True, text=True, timeout=120)
    if p.returncode:
        raise RuntimeError(f"gh api {endpoint}: {p.stderr.strip()[-300:]}")
    return json.loads(p.stdout)


# gh lends git its login, so cloning a private repository needs nothing beyond `gh auth login`.
GIT_AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def git(mirror: Path, *args: str) -> bytes:
    return subprocess.run(["git", f"--git-dir={mirror}", *args], check=True, capture_output=True).stdout


def clone(repo: str, repos_dir: Path) -> Path:
    """A bare clone of the repository, made once and reused."""
    path = repos_dir / f"{repo.replace('/', '__')}.git"
    if not path.exists():
        repos_dir.mkdir(parents=True, exist_ok=True)
        print(f"cloning {repo} into {path}")
        if subprocess.run(["git", *GIT_AUTH, "clone", "--bare", "--quiet", f"https://github.com/{repo}.git", str(path)],
                          env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}).returncode:
            raise SystemExit(f"couldn't clone {repo}: check that `gh auth status` shows an account with access to it")
    return path


def ensure_commit(mirror: Path, sha: str) -> None:
    """Fetch a commit the clone doesn't have yet, such as a merge newer than the clone."""
    if subprocess.run(["git", f"--git-dir={mirror}", "cat-file", "-e", f"{sha}^{{commit}}"],
                      capture_output=True).returncode:
        subprocess.run(["git", *GIT_AUTH, f"--git-dir={mirror}", "fetch", "--quiet", "origin", sha],
                       check=True, capture_output=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def clean_text(text: str) -> str:
    """Drop what only renders on GitHub (HTML comments, images); keep code and examples."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    return re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text).strip()


def request(repo: str, pr: dict) -> tuple[str, str]:
    """What the agent is asked to do, and where it came from.

    The first issue the PR says it closes, when that issue says enough; otherwise the
    PR's own title and description.
    """
    body = clean_text(pr.get("body") or "")
    for match in CLOSES_ISSUE.finditer(body):
        number = int(match[3])
        if (match[1] or match[2] or repo).lower() != repo.lower() or number == pr["number"]:
            continue
        try:
            issue = gh(f"repos/{repo}/issues/{number}")
        except RuntimeError:
            continue  # deleted or transferred
        if issue.get("pull_request"):
            continue
        issue_body = clean_text(issue.get("body") or "")
        if len(issue_body) >= MIN_REQUEST_CHARS:
            return f"{issue['title']}\n\n{issue_body}", "linked-issue"
        break
    return f"{pr['title']}\n\n{body}", "pr-description"


def changed_files(mirror: Path, base: str, reference: str) -> list[dict]:
    files = []
    for entry in git(mirror, "diff", "--no-renames", "--numstat", "-z", base, reference).decode().split("\0"):
        if entry:
            added, deleted, path = entry.split("\t", 2)
            role = ("test" if TEST_FILE.search(path) else
                    "implementation" if SOURCE_FILE.search(path) and not path.startswith(("docs/", "examples/"))
                    else "support")
            # binary files show "-" for both counts
            files.append({"path": path, "role": role, "lines": sum(int(n) for n in (added, deleted) if n.isdigit())})
    return files


TEST_SH = """#!/usr/bin/env bash
# Harbor-style verifier: overlay the PR's tests, run the suite, write the reward.
set -uo pipefail
cd /workspace
while IFS= read -r path; do [ -n "$path" ] && rm -f -- "$path"; done < /tests/deleted.txt
cp -R /tests/files/. /workspace/
mkdir -p /logs/verifier
{test}
code=$?
[ "$code" -eq 0 ] && echo 1 > /logs/verifier/reward.txt || echo 0 > /logs/verifier/reward.txt
exit "$code"
"""


def export_task(mirror: Path, repo: str, language: str, pr: dict, out: Path, *,
                setup: str | None = None, test: str | None = None) -> Path:
    """Write tasks/<id> for one merged pull request. Raises Skip if it can't be a task."""
    reference = pr["merge_commit_sha"]
    ensure_commit(mirror, reference)
    parents = git(mirror, "rev-list", "--parents", "-n", "1", reference).decode().split()
    if len(parents) < 2:
        raise Skip("the merge has no parent commit")
    base = parents[1]  # what the default branch looked like just before the merge
    files = changed_files(mirror, base, reference)
    test_paths = [f["path"] for f in files if f["role"] == "test"]
    if not test_paths or not any(f["role"] == "implementation" for f in files):
        raise Skip("doesn't change both code and tests")
    lines = sum(f["lines"] for f in files)
    if len(files) > MAX_FILES or lines > MAX_LINES:
        raise Skip(f"too large ({len(files)} files, {lines} lines)")
    patch = git(mirror, "diff", "--binary", "--no-renames", base, reference)
    if len(patch) > MAX_PATCH_BYTES:
        raise Skip("diff too large")

    package_json = None
    if language in ("TypeScript", "JavaScript"):
        try:
            package_json = json.loads(git(mirror, "show", f"{base}:package.json"))
        except subprocess.CalledProcessError:
            pass
    commands = recipe(repo, language, test_paths, package_json) if not (setup and test) else {}
    commands = {"setup": setup or commands["setup"], "scope": commands.get("scope", "the given test command"),
                "test": (test or commands["test"]).replace("{test_files}", " ".join(map(shlex.quote, test_paths)))}
    text, source = request(repo, pr)
    if len(text.strip()) < MIN_REQUEST_CHARS:
        raise Skip("the PR and its issue say too little to work from")

    task_id = f"{repo.replace('/', '__')}-{pr['number']}"
    tmp = out / f".{task_id}.partial"
    shutil.rmtree(tmp, ignore_errors=True)
    for folder in ("environment", "tests/files", "solution"):
        (tmp / folder).mkdir(parents=True)
    (tmp / "environment" / "source.tar").write_bytes(git(mirror, "archive", "--format=tar", base))
    present = set(git(mirror, "ls-tree", "-r", "--name-only", reference, "--", *test_paths).decode().splitlines())
    for path in test_paths:
        if path in present:
            target = tmp / "tests" / "files" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(mirror, "show", f"{reference}:{path}"))
    deleted = [p for p in test_paths if p not in present]
    (tmp / "tests" / "deleted.txt").write_text("".join(p + "\n" for p in deleted))
    (tmp / "tests" / "test.sh").write_text(TEST_SH.format(test=commands["test"]))
    (tmp / "tests" / "test.sh").chmod(0o755)
    (tmp / "solution" / "reference.patch").write_bytes(patch)
    (tmp / "instruction.md").write_text(f"# {pr['title']}\n\n{text.strip()}\n")
    size = "small" if lines <= 100 else "medium" if lines <= 400 else "large"
    write_toml(tmp / "task.toml", {
        "task": {"id": task_id, "repo": repo, "pr_number": pr["number"], "url": pr["html_url"],
                 "title": pr["title"], "language": language, "size_bucket": size, "lines_changed": lines,
                 "files_changed": len(files), "merged_at": pr["merged_at"], "base_sha": base,
                 "reference_sha": reference, "instruction_source": source},
        "environment": {"setup": commands["setup"], "setup_timeout_sec": 900},
        "agent": {"timeout_sec": 1800},
        "verifier": {"test": commands["test"], "scope": commands["scope"], "timeout_sec": 900,
                     "test_files": test_paths, "deleted_test_files": deleted},
    })
    dest = out / task_id
    shutil.rmtree(dest, ignore_errors=True)
    tmp.rename(dest)
    return dest


def merged_prs(repo: str, since: str | None = None, pages: int = 10):
    """Merged pull requests, most recently updated first."""
    for page in range(1, pages + 1):
        listing = gh(f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}")
        if not listing:
            return
        for pr in listing:
            if pr.get("merged_at") and (not since or pr["merged_at"][:10] >= since):
                yield pr


def collect(repo: str, out: Path = DEFAULT_TASKS, *, prs: list[int] | None = None, limit: int = 20,
            since: str | None = None, setup: str | None = None, test: str | None = None,
            language: str | None = None, repos_dir: Path = DEFAULT_REPOS, force: bool = False) -> list[Path]:
    """Task folders for one repository: the given PR numbers, or up to `limit` recent merged PRs.

    Folders that already exist are kept unless `force`, so collecting again is cheap and
    keeps their validation results.
    """
    def folder(number: int) -> Path:
        return out / f"{repo.replace('/', '__')}-{number}"

    def kept(number: int) -> bool:
        return not force and (folder(number) / "task.toml").is_file()

    written = [folder(n) for n in prs or [] if kept(n)]
    todo = [n for n in prs or [] if not kept(n)]
    if prs and not todo:
        return written  # nothing new to fetch
    try:
        language = language or gh(f"repos/{repo}").get("language") or "unknown"
    except RuntimeError as exc:
        raise SystemExit(f"can't read {repo} on GitHub: {exc}") from None
    if not (setup and test):
        try:
            recipe(repo, language, [])
        except Skip as why:
            raise SystemExit(f"{repo}: {why}") from None
    mirror = clone(repo, repos_dir)
    out.mkdir(parents=True, exist_ok=True)
    candidates = (gh(f"repos/{repo}/pulls/{n}") for n in todo) if prs else merged_prs(repo, since)
    skipped = 0
    for pr in candidates:
        if not prs and len(written) >= limit:
            break
        if kept(pr["number"]):
            written.append(folder(pr["number"]))
            continue
        try:
            if not prs and MAINTENANCE.search(pr["title"]):
                raise Skip("maintenance, not a code change")
            written.append(export_task(mirror, repo, language, pr, out, setup=setup, test=test))
            print(f"  {repo}#{pr['number']}: {pr['title']}")
        except Skip as why:
            skipped += 1
            if prs:  # asked for by number, so say why
                print(f"  {repo}#{pr['number']}: skipped, {why}")
    if skipped and not prs:
        print(f"  {repo}: passed over {skipped} merged PRs (maintenance, no test changes, or too large)")
    return written


def sample() -> dict[str, list[int]]:
    """The sample tasks' repositories and PR numbers, from configs/sample_tasks.toml."""
    return tomllib.loads(SAMPLE.read_text())


def spread(rows, limit, repo=lambda row: row["repo"]):
    """Take `limit` rows round-robin across repositories, so a small sample still mixes them.

    Rows must be in merge order within each repository; the newest go first.
    """
    by_repo: dict[str, list] = {}
    for row in rows:
        by_repo.setdefault(repo(row), []).append(row)
    picked = []
    while len(picked) < limit and any(by_repo.values()):
        for name in sorted(by_repo):
            if by_repo[name] and len(picked) < limit:
                picked.append(by_repo[name].pop())  # newest first: least likely to be memorized
    return picked


def load(path: Path) -> Task:
    meta = tomllib.loads((path / "task.toml").read_text())
    return Task(id=meta["task"]["id"], path=path, meta=meta, instruction=(path / "instruction.md").read_text())


def discover(tasks_dir: Path, ids=None) -> list[Task]:
    found = [load(p) for p in sorted(tasks_dir.iterdir()) if (p / "task.toml").is_file()]
    if ids:
        missing = set(ids) - {t.id for t in found}
        if missing:
            raise SystemExit(f"not in {tasks_dir}: {', '.join(sorted(missing))}")
        found = [t for t in found if t.id in ids]
    return found
