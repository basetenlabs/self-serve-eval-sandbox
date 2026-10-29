"""Turn merged pull requests into self-contained task folders.

A task folder is what one trial needs and nothing more:

    tasks/<id>/
      task.toml                  metadata, setup and test commands, timeouts
      instruction.md             what the agent is asked to do (PR or issue text, names the tests call)
      environment/source.tar.gz  the repository at the PR's base commit, no .git
      tests/files/...            the PR's test files at the merged commit   (hidden)
      tests/deleted.txt          test files the PR removed                  (hidden)
      tests/test.sh              runs the hidden tests, Harbor-style reward  (hidden)
      solution/reference.patch   the merged diff, for the judge             (hidden)

Only `environment/` and `instruction.md` ever reach the agent. The rest is copied into
a fresh verifier sandbox after the agent has finished.

Pull requests come from GitHub through the `gh` CLI, so private repositories work with
whatever access `gh auth login` gave. Each repository is cloned once, bare, into
data/repos/; the clone never enters a sandbox.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TASKS = ROOT / "tasks"
DEFAULT_REPOS = ROOT / "data" / "repos"
SAMPLE = ROOT / "configs" / "sample_tasks.toml"
QUICK = ROOT / "configs" / "quick_tasks.toml"

# A PR makes a good task when it changes code and tests together and is a reviewable size.
# Scans of recent PRs take only those up to DEFAULT_MAX_LINES; bigger ones cost a lot per
# attempt and tell little. PRs asked for by number may go up to MAX_LINES.
MAX_FILES, MAX_LINES, DEFAULT_MAX_LINES, MAX_PATCH_BYTES, MIN_REQUEST_CHARS = 40, 1600, 400, 400_000, 80
# Test files, and what only tests read (Go testdata, snapshots): all of it is hidden from the agent.
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|__snapshots__|testing|testdata|fixtures)(/|$)"
                       r"|(?:_test\.go|[._](?:test|spec)\.[cm]?[jt]sx?|^test_[^/]+\.py|/test_[^/]+\.py|\.snap)$", re.I)
SOURCE_FILE = re.compile(r"\.(?:py|go|[cm]?[jt]sx?|rs|c|cc|cpp|h|hpp|java|kt|kts|scala|swift|cs|rb|php|ex|exs)$", re.I)
MAINTENANCE = re.compile(r"\b(bump|dependabot|renovate|release|changelog|typo|readme|ci|workflow|pre-commit|"
                         r"formatting|linting|translations?|backport|merge \S+ into)\b", re.I)
CLOSES_ISSUE = re.compile(r"\b(?:fix(?:es|ed)?|clos(?:e[sd]?|ing)|resolv(?:e[sd]?|ing))\s+"
                          r"(?:(?:https://github.com/([^/\s]+/[^/\s]+)/issues/)|(?:(\w[\w.-]*/[\w.-]+))?#)(\d+)", re.I)
# A line that defines a name: a function, method, class or type (group 1), or a top-level
# variable or constant (group 2). Go, Python, JavaScript/TypeScript and Rust.
DEFINITION = re.compile(
    r"^\s*(?:pub(?:\([^)]*\))?\s+|export\s+(?:default\s+)?)?(?:async\s+)?"
    r"(?:func\s+(?:\([^)]*\)\s*)?|def\s+|fn\s+|function\*?\s+|class\s+|interface\s+|struct\s+|enum\s+|trait\s+)(\w+)"
    r"|^(?:export\s+)?(?:type|var|const|let)\s+(\w+)")
# A pull request as people paste it: its GitHub link, or owner/repo#number.
PULL = re.compile(r"(?:(?:https?://)?(?:www\.)?github\.com/)?([\w.-]+/[\w.-]+?)(?:/pulls?/|#)(\d+)(?:[/?#].*)?")
GO_IMPORT_BLOCK = re.compile(r"^import\s*\((.*?)^\)", re.M | re.S)
GO_IMPORT_LINE = re.compile(r'^import\s+(?:[\w.]+\s+)?"([^"]+)"', re.M)


@dataclass
class Task:
    id: str
    path: Path
    meta: dict
    instruction: str


class Skip(Exception):
    """A pull request that can't be a task, and why."""


def parse_pull(text: str) -> tuple[str, int] | None:
    """(owner/repo, number) from a pull request's link or owner/repo#number, else None."""
    match = PULL.fullmatch(text.strip())
    return (match[1], int(match[2])) if match else None


def role(path: str) -> str:
    """What a changed file is to a task: a test, the implementation, or support (docs, config)."""
    if TEST_FILE.search(path):
        return "test"
    return "implementation" if SOURCE_FILE.search(path) and not path.startswith(("docs/", "examples/")) else "support"


def unfit(files: list[dict], max_lines: int = MAX_LINES) -> str | None:
    """Why a PR changing these files ({path, role, lines}) can't be a task, or None."""
    if not any(f["role"] == "test" for f in files) or not any(f["role"] == "implementation" for f in files):
        return "doesn't change both code and tests"
    lines = sum(f["lines"] for f in files)
    if len(files) > MAX_FILES or lines > max_lines:
        return f"too large ({len(files)} files, {lines} lines)"
    return None


def recipe(repo: str, language: str, test_paths: list[str], package_json: dict | None = None,
           imports: list[str] | None = None) -> dict:
    """Default setup and test commands for a repository; `--setup` and `--test` override them.

    The tests run are the repository's default suite, except where that suite needs more
    than one sandbox (Hono: only the PR's changed test files; Grafana: only their Go packages).
    `imports` are the Go packages the merged change imports. `memory` (MB) is the smallest
    sandbox the repository fits in, where the default is too small.
    """
    if repo == "grafana/grafana":
        packages = " ".join(sorted({"./" + os.path.dirname(p) for p in test_paths if p.endswith("_test.go")}))
        if test_paths and not packages:
            raise Skip("no Go tests (only Grafana's Go tests run here)")
        # All its modules don't fit in a sandbox, and the agent and the tests run without network:
        # download what the test packages and the merged change import (packages the change adds
        # don't exist yet, hence `|| true`), then compile the test packages once, as they are
        # before the change, to warm the build cache.
        wanted = " ".join([packages, *map(shlex.quote, imports or [])])
        return {"setup": (f"{{ go list -e -deps -test {wanted} >/dev/null || true; }} && "
                          f"{{ go test -count=1 -run '^$' {packages} >/dev/null 2>&1 || true; }}"),
                "test": f"go test -count=1 -timeout=600s {packages}",
                "scope": "the Go packages of the PR's changed tests", "setup_timeout": 1800,
                "memory": 16384}  # the sandbox size its runs are proven at
    if repo == "PostHog/posthog":
        files = [p for p in test_paths if p.endswith(".py")]
        if test_paths and not files:
            raise Skip("no Python tests (only PostHog's Python tests run here)")
        # It pins its Python and a newer uv than the image's. Disk is half the memory, and its
        # environment and uv's cache don't both fit as copies, so the environment hardlinks the cache.
        return {"setup": ("export UV_PYTHON_INSTALL_DIR=$HOME/.uv-python UV_LINK_MODE=hardlink && "
                          "uvx uv@latest sync --frozen --no-progress --quiet --no-install-package pywatchman"),
                "test": ".venv/bin/python -m pytest -q --tb=short -p no:cacheprovider "
                        + " ".join(shlex.quote(p) for p in files),
                "scope": "the PR's changed Python test files", "setup_timeout": 1800, "memory": 16384}
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


def gh(endpoint: str, token: str | None = None):
    """One GitHub API call through the gh CLI, which carries the user's own login, or `token`:
    the hosted page's visitor's, when they signed in with GitHub."""
    if not shutil.which("gh"):
        raise SystemExit("pr-eval collect reads pull requests with the GitHub CLI: install gh, then `gh auth login`.")
    p = subprocess.run(["gh", "api", endpoint], capture_output=True, text=True, timeout=120,
                       env={**os.environ, "GH_TOKEN": token} if token else None)
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


def base_commit(mirror: Path, repo: str, pr: dict, reference: str) -> str:
    """What the default branch looked like just before the PR landed.

    For a merge commit, its first parent; for a squash merge, its parent. A rebase merge
    lays the PR's commits onto the branch one by one and `merge_commit_sha` is only the
    last, so its parent already holds the PR's earlier commits: step back past all of them.
    """
    parents = git(mirror, "rev-list", "--parents", "-n", "1", reference).decode().split()
    if len(parents) < 2:
        raise Skip("the merge has no parent commit")
    if len(parents) > 2:
        return parents[1]
    commits = gh(f"repos/{repo}/pulls/{pr['number']}/commits?per_page=100")
    if len(commits) > 1:
        landed = git(mirror, "log", "--format=%s", f"-n{len(commits)}", reference).decode().splitlines()
        if landed == [(c["commit"]["message"].splitlines() or [""])[0] for c in reversed(commits)]:
            return git(mirror, "rev-parse", f"{reference}~{len(commits)}").decode().strip()
    return parents[1]


def changed_files(mirror: Path, base: str, reference: str) -> list[dict]:
    files = []
    for entry in git(mirror, "diff", "--no-renames", "--numstat", "-z", base, reference).decode().split("\0"):
        if entry:
            added, deleted, path = entry.split("\t", 2)
            # binary files show "-" for both counts
            files.append({"path": path, "role": role(path), "lines": sum(int(n) for n in (added, deleted) if n.isdigit())})
    return files


def signatures(lines: list[str]):
    """(name, signature) for each definition in these lines: the definition line, plus the
    lines that finish its parameter list, without the body, and without a variable's value."""
    for i, line in enumerate(lines):
        match = DEFINITION.match(line)
        if not match:
            continue
        parts = [line.strip()]
        while sum(p.count("(") - p.count(")") for p in parts) > 0 and i + len(parts) < len(lines) and len(parts) < 8:
            parts.append(lines[i + len(parts)].strip())
        text = " ".join(parts)
        yield match[1] or match[2], (text.split("=", 1)[0] if match[2] else text).rstrip(" {:=")


def parameters(name: str, signature: str) -> str:
    """The parameter list that follows the name, or "" if there is none."""
    rest = re.split(rf"\b{re.escape(name)}\b", signature, maxsplit=1)[-1]
    start, depth = rest.find("("), 0
    for i, char in enumerate(rest[start:] if start >= 0 else ""):
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth == 0:
            return rest[start:start + i + 1]
    return ""


def interface(mirror: Path, base: str, reference: str, paths: list[str], tests: str, text: str) -> list[str]:
    """What the PR's tests call by name that the request doesn't give away.

    Tests often call helpers the PR itself added, or functions whose parameters it changed;
    a correct fix that names or orders them differently can't even compile against those
    tests. So, like SWE-bench Pro, the request lists their signatures: names the PR added
    and functions whose parameters it changed, leaving out a parameterless name (a constant,
    a type) the request already mentions. Never a body or a value, and nothing for a change
    to a return type alone, which would describe the behavior the tests check.
    """
    diff = git(mirror, "diff", "-U0", "--no-renames", base, reference, "--", *paths).decode(errors="replace")
    hunks, path = [], None
    for line in diff.splitlines():
        if line.startswith(("--- a/", "--- /dev/null")):
            continue
        if line.startswith(("+++ b/", "+++ /dev/null")):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            hunks.append((path, [], []))
        elif hunks and line[:1] in ("-", "+"):
            hunks[-1][1 if line[0] == "-" else 2].append(line[1:])
    removed = {name: sig for _, gone, _ in hunks for name, sig in signatures(gone)}
    found, seen = [], set()
    for path, _, added in hunks:
        for name, sig in signatures(added):
            used = re.compile(rf"\b{re.escape(name)}\b")
            if not path or name in seen or not used.search(tests):
                continue
            if name in removed:
                if parameters(name, removed[name]) == parameters(name, sig):
                    continue  # same parameters: nothing a test could trip over
            elif used.search(text) and not parameters(name, sig):
                continue  # the request already names it, and there are no parameters to get wrong
            seen.add(name)
            found.append(f"- `{path}`: `{sig}`")
    return found


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


def go_imports(mirror: Path, commit: str, paths: list[str]) -> list[str]:
    """Non-standard-library packages the Go files import at a commit (files missing there are skipped)."""
    found = set()
    for path in paths:
        try:
            source = git(mirror, "show", f"{commit}:{path}").decode(errors="replace")
        except subprocess.CalledProcessError:
            continue
        for block in GO_IMPORT_BLOCK.findall(source):
            found.update(re.findall(r'"([^"]+)"', block))
        found.update(GO_IMPORT_LINE.findall(source))
    return sorted(p for p in found if "." in p.split("/")[0])


def export_task(mirror: Path, repo: str, language: str, pr: dict, out: Path, *,
                setup: str | None = None, test: str | None = None, max_lines: int = MAX_LINES) -> Path:
    """Write tasks/<id> for one merged pull request. Raises Skip if it can't be a task."""
    reference = pr["merge_commit_sha"]
    ensure_commit(mirror, reference)
    base = base_commit(mirror, repo, pr, reference)
    files = changed_files(mirror, base, reference)
    test_paths = [f["path"] for f in files if f["role"] == "test"]
    if why := unfit(files, max_lines):
        raise Skip(why)
    lines = sum(f["lines"] for f in files)
    patch = git(mirror, "diff", "--binary", "--no-renames", base, reference)
    if len(patch) > MAX_PATCH_BYTES:
        raise Skip("diff too large")

    package_json = None
    if language in ("TypeScript", "JavaScript"):
        try:
            package_json = json.loads(git(mirror, "show", f"{base}:package.json"))
        except subprocess.CalledProcessError:
            pass
    present = set(git(mirror, "ls-tree", "-r", "--name-only", reference, "--", *test_paths).decode().splitlines())
    # {test_files}: the PR's test sources that still exist, not its fixtures or deleted tests
    runnable = [p for p in test_paths if p in present and SOURCE_FILE.search(p)]
    go_files = [f["path"] for f in files if f["path"].endswith(".go")]
    imports = go_imports(mirror, reference, go_files) if repo == "grafana/grafana" else None
    commands = recipe(repo, language, runnable, package_json, imports) if not (setup and test) else {}
    template = test or commands["test"]
    commands = {"setup": setup or commands["setup"], "scope": commands.get("scope", "the given test command"),
                "setup_timeout": commands.get("setup_timeout", 900), "memory": commands.get("memory"),
                "test": template.replace("{test_files}", " ".join(map(shlex.quote, runnable)))}
    text, source = request(repo, pr)
    if len(text.strip()) < MIN_REQUEST_CHARS:
        raise Skip("the PR and its issue say too little to work from")
    hidden = {p: git(mirror, "show", f"{reference}:{p}") for p in test_paths if p in present}
    names = interface(mirror, base, reference, [f["path"] for f in files if f["role"] == "implementation"],
                      "\n".join(hidden[p].decode(errors="replace") for p in runnable), text)
    if names:
        text = (text.strip() + "\n\n## Names the tests use\n\nTests for this change call these by name, so give "
                "them these names and parameters. Everything else about them is up to you.\n\n" + "\n".join(names))

    task_id = f"{repo.replace('/', '__')}-{pr['number']}"
    tmp = out / f".{task_id}.partial"
    shutil.rmtree(tmp, ignore_errors=True)
    for folder in ("environment", "tests/files", "solution"):
        (tmp / folder).mkdir(parents=True)
    # Compressed, it is about a quarter the size to keep and to upload to each sandbox.
    (tmp / "environment" / "source.tar.gz").write_bytes(
        gzip.compress(git(mirror, "archive", "--format=tar", base), compresslevel=6, mtime=0))
    for path, content in hidden.items():
        target = tmp / "tests" / "files" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
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
        "environment": {"setup": commands["setup"], "setup_timeout_sec": commands["setup_timeout"],
                        **({"memory_mb": commands["memory"]} if commands["memory"] else {})},
        "agent": {"timeout_sec": 1800},
        "verifier": {"test": commands["test"], "test_template": template, "scope": commands["scope"], "timeout_sec": 900,
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


def browse(repo: str, numbers: list[int] | None = None, count: int = 30, token: str | None = None) -> list[dict]:
    """Pull requests to pick from, and whether each can be a task: `numbers`, in that order,
    else the most recently merged, newest first.

    Reads each one's changed files from GitHub (not the clone), so it answers in seconds.
    """
    def fetch(number: int) -> dict:
        try:
            return gh(f"repos/{repo}/pulls/{number}", token)
        except RuntimeError:
            return {"number": number, "html_url": f"https://github.com/{repo}/pull/{number}", "missing": True}

    def row(pr: dict) -> dict:
        files, why = [], None
        if pr.get("missing"):
            why = "GitHub has no such pull request"
        elif not pr.get("merged_at"):
            why = "not merged"
        else:
            try:
                files = [{"path": f["filename"], "role": role(f["filename"]), "lines": f["additions"] + f["deletions"]}
                         for f in gh(f"repos/{repo}/pulls/{pr['number']}/files?per_page=100", token)]
                why = unfit(files)
            except RuntimeError:
                why = "GitHub didn't list its files"
        title = pr.get("title") or ""
        return {"number": pr["number"], "title": title, "url": pr["html_url"], "merged_at": pr.get("merged_at"),
                "author": (pr.get("user") or {}).get("login"), "files": len(files),
                "lines": sum(f["lines"] for f in files), "tests": sum(f["role"] == "test" for f in files),
                "why": why, "maintenance": bool(MAINTENANCE.search(title))}

    # Each answer takes GitHub about half a second: 30 pull requests' files take 1.0 s 16 at a time, 2.0 s 8 at a time.
    with ThreadPoolExecutor(max_workers=16) as pool:
        if numbers:
            prs = list(pool.map(fetch, numbers))
        else:
            merged = []
            for page in range(1, 6):  # many closed PRs were never merged, so one page can hold too few
                listing = gh(f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}", token)
                merged += [pr for pr in listing if pr.get("merged_at")]
                if len(listing) < 100 or len(merged) >= count:
                    break
            prs = sorted(merged, key=lambda pr: pr["merged_at"], reverse=True)[:count]
        return list(pool.map(row, prs))


def search(repo: str, words: str, token: str | None = None, count: int = 12) -> list[int]:
    """Merged pull requests whose title or description has these words, by GitHub's search, best first."""
    if number := re.fullmatch(r"#?(\d+)", words.strip()):
        return [int(number[1])]
    terms = " ".join(re.findall(r"[\w.-]+", words))[:200]
    if not terms:
        return []
    found = gh(f"search/issues?q={quote(f'repo:{repo} is:pr is:merged {terms}')}&per_page={count}", token)
    return [item["number"] for item in found.get("items", [])]


def collect(repo: str, out: Path = DEFAULT_TASKS, *, prs: list[int] | None = None, limit: int = 20,
            since: str | None = None, setup: str | None = None, test: str | None = None,
            language: str | None = None, repos_dir: Path = DEFAULT_REPOS, force: bool = False,
            max_lines: int = DEFAULT_MAX_LINES) -> list[Path]:
    """Task folders for one repository: the given PR numbers, or up to `limit` recent merged PRs.

    Folders that already exist are kept unless `force`, so collecting again is cheap and
    keeps their validation results. One made with other install or test commands than
    these is made again, and so checked again.
    """
    def folder(number: int) -> Path:
        return out / f"{repo.replace('/', '__')}-{number}"

    def kept(number: int) -> bool:
        if force or not (folder(number) / "task.toml").is_file():
            return False
        meta = load(folder(number)).meta
        return ((not setup or meta["environment"]["setup"] == setup)
                and (not test or meta["verifier"].get("test_template", meta["verifier"]["test"]) == test))

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
            if prs or load(folder(pr["number"])).meta["task"]["lines_changed"] <= max_lines:
                written.append(folder(pr["number"]))
            continue
        try:
            if not prs and MAINTENANCE.search(pr["title"]):
                raise Skip("maintenance, not a code change")
            written.append(export_task(mirror, repo, language, pr, out, setup=setup, test=test,
                                       max_lines=MAX_LINES if prs else max_lines))
            print(f"  {repo}#{pr['number']}: {pr['title']}")
        except Skip as why:
            skipped += 1
            if prs:  # asked for by number, so say why
                print(f"  {repo}#{pr['number']}: skipped, {why}")
    if skipped and not prs:
        print(f"  {repo}: passed over {skipped} merged PRs (maintenance, no test changes, or too large)")
    return written


def sample(quick: bool = False) -> dict[str, list[int]]:
    """The sample tasks' repositories and PR numbers, from configs/sample_tasks.toml
    (configs/quick_tasks.toml for the quick sample)."""
    return tomllib.loads((QUICK if quick else SAMPLE).read_text())


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


_COMPRESSING = threading.Lock()


def snapshot(task: Task) -> Path:
    """The task's gzipped source. A task collected before snapshots were compressed has a plain
    source.tar, which is compressed in place the first time it is needed."""
    env = task.path / "environment"
    packed, plain = env / "source.tar.gz", env / "source.tar"
    if packed.is_file():
        return packed
    with _COMPRESSING:
        if not packed.is_file():
            # Another run may be compressing it too: each writes its own file and the last
            # rename wins, both with the same bytes.
            tmp = env / f".source.tar.gz.{os.getpid()}"
            try:
                with plain.open("rb") as src, tmp.open("wb") as raw, \
                        gzip.GzipFile("", "wb", compresslevel=6, fileobj=raw, mtime=0) as out:
                    shutil.copyfileobj(src, out, 1 << 20)
                tmp.replace(packed)
                plain.unlink(missing_ok=True)
            except FileNotFoundError:  # the other run finished first and removed the plain one
                tmp.unlink(missing_ok=True)
                if not packed.is_file():
                    raise
    return packed


def load(path: Path) -> Task:
    meta = tomllib.loads((path / "task.toml").read_text())
    return Task(id=meta["task"]["id"], path=path, meta=meta, instruction=(path / "instruction.md").read_text())


def discover(tasks_dir: Path, ids=None) -> list[Task]:
    if not tasks_dir.is_dir():
        raise SystemExit(f"no tasks in {tasks_dir} yet: `pr-eval run owner/repo` or `pr-eval collect` makes them")
    found = [load(p) for p in sorted(tasks_dir.iterdir()) if (p / "task.toml").is_file()]
    if ids:
        missing = set(ids) - {t.id for t in found}
        if missing:
            raise SystemExit(f"not in {tasks_dir}: {', '.join(sorted(missing))}")
        found = [t for t in found if t.id in ids]
    return found
