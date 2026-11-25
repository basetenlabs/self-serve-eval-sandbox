"""Install and test commands for a repository a run was given none for.

Before any pull request is checked, the run works them out on one of its pull requests. A guess comes
first: Go's and Python's defaults, or one read from the repository's own files (its lockfile, package
manager and test runner). The guess is proved in a sandbox: the install succeeds, and at the merged
commit the test command finds the PR's tests and passes them. When it fails, a small model loop on this
machine reads the output and the repository, proposes commands and proves them again, a few tries at
most. The model's key stays on this machine: the sandboxes only run commands. What works is kept per
repository in data/commands.json, so the next run starts from it; that run's check still proves it.
"""
from __future__ import annotations

import fcntl
import json
import os
import posixpath
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from . import config, meter, runner, runtime, tasks
from .rundir import charge, now

SAVED = tasks.DEFAULT_REPOS.parent / "commands.json"
MODEL = "deepseek-v4.1-flash"  # reading CI files and test output needs no more, and it costs cents
TRIES = 4          # commands the model may prove, after the first guess
TURNS = 24         # its answers in all
BUDGET_USD = 1.0   # it stops past this; working a repository out usually costs a few cents
RUN_SECONDS = 600  # one command it runs to look around
OUTPUT_CHARS = 5000
CHAT_TIMEOUT = 180
# Until the run works them out: a test command that fails, so no task can pass on it.
UNKNOWN = {"setup": "true", "test": "echo 'pr-eval: no test command worked out yet' >&2; exit 1",
           "scope": "worked out when the run starts"}
NODE = ("TypeScript", "JavaScript")
LOCKFILES = (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("package-lock.json", "npm"),
             ("npm-shrinkwrap.json", "npm"), ("bun.lock", "bun"), ("bun.lockb", "bun"))
# Each runner on just the files it's given, without coverage or watching.
RUNNERS = {"vitest": "vitest run --coverage.enabled=false", "jest": "jest --ci --coverage=false --runTestsByPath",
           "mocha": "mocha", "ava": "ava"}
BINS = 'export PATH="$PWD/node_modules/.bin:$PATH"'
CARGO = 'export PATH="$HOME/.cargo/bin:$PATH"'


def saved(repo: str, path: Path | None = None) -> dict | None:
    """The commands an earlier run worked out and proved for this repository."""
    try:
        entry = json.loads((path or SAVED).read_text()).get(repo.lower())
    except (OSError, ValueError, AttributeError):
        return None
    return entry if isinstance(entry, dict) and entry.get("setup") and entry.get("test") else None


def keep(repo: str, entry: dict | None, path: Path | None = None) -> None:
    """Save (or, with None, forget) a repository's commands. Runs in other processes may write at once."""
    path = path or SAVED
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            data = {}
        if entry is None:
            data.pop(repo.lower(), None)
        else:
            data[repo.lower()] = entry
        tmp = path.with_name(f".{path.name}.{os.getpid()}")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        tmp.replace(path)


def curated(repo: str) -> bool:
    """A repository with commands of its own in tasks.recipe (the samples'): nothing to work out."""
    try:
        tasks.recipe(repo, "", [])
        return True
    except tasks.Skip:
        return False


def used(task: tasks.Task) -> tuple[str, str]:
    """A task's install command and test command template."""
    verifier = task.meta["verifier"]
    return task.meta["environment"]["setup"], verifier.get("test_template", verifier["test"])


# The first guess.

def first_guess(mirror: Path, commit: str, language: str, test_files: list[str]) -> dict:
    """tasks.export_task's commands for a repository with none of its own: a guess from its files at
    the PR's base, or UNKNOWN; either is worked out when the run starts."""
    return guess(language, *files_at(mirror, commit), test_files) or dict(UNKNOWN)


def files_at(mirror: Path, commit: str) -> tuple[list[str], Callable[[str], str | None]]:
    """Every file's path at a commit of the run's clone, and a reader for one file's text."""
    paths = tasks.git(mirror, "ls-tree", "-r", "--name-only", commit).decode(errors="replace").splitlines()

    def read(path: str) -> str | None:
        try:
            return tasks.git(mirror, "show", f"{commit}:{path}").decode(errors="replace")
        except subprocess.CalledProcessError:
            return None
    return paths, read


def guess(language: str, paths: list[str], read: Callable[[str], str | None], test_files: list[str]) -> dict | None:
    """{setup, test, scope} from the repository's files, {test_files} in the test command; None when
    nothing fits. Go and Python keep their defaults."""
    if language in ("Go", "Python"):
        return tasks.recipe("", language, [])
    names = set(paths)
    if "package.json" in names or (language in NODE and any(p.endswith("/package.json") for p in names)):
        return node(names, read, test_files)
    if "Cargo.toml" in names:
        # The image has no Rust: rustup puts it under $HOME, where the tests find it offline.
        return {"setup": (f"{CARGO} && {{ command -v cargo >/dev/null || curl --proto '=https' --tlsv1.2 -sSf "
                          "https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path; } && "
                          "cargo fetch && cargo test --no-run"),
                "test": f"{CARGO} && cargo test --offline", "scope": "repository default suite"}
    return None


def up(folder: str) -> list[str]:
    """A folder and each one above it, to the repository's root ("")."""
    found = []
    while folder not in ("", "."):
        found.append(folder)
        folder = posixpath.dirname(folder)
    return found + [""]


def node(names: set[str], read, test_files: list[str]) -> dict | None:
    """Node: install with the lockfile's package manager (corepack runs the version packageManager
    pins), then the test runner its package uses, from the folder of the package the PR's tests are in."""
    homes = [next((d for d in up(posixpath.dirname(f)) if posixpath.join(d, "package.json") in names), "")
             for f in test_files]
    home = max(set(homes), key=homes.count) if homes else ""
    package, root = json_file(read, posixpath.join(home, "package.json")), json_file(read, "package.json")
    if package is None:
        return None
    where = next((d for d in up(home) if lock_of(names, d)), "")
    lock = lock_of(names, where)
    pinned = str((json_file(read, posixpath.join(where, "package.json")) or root or {}).get("packageManager") or "")
    manager = pinned.split("@")[0] if pinned else lock[1] if lock else "npm"
    major = re.match(r"\w+@(\d+)", pinned)
    if manager == "pnpm":
        setup = "pnpm install" + (" --frozen-lockfile" if lock else "")
    elif manager == "yarn":
        berry = int(major[1]) >= 2 if major else posixpath.join(where, ".yarnrc.yml") in names
        setup = "yarn install" + ((" --immutable" if berry else " --frozen-lockfile") if lock else "")
    elif manager == "npm":
        setup = ("npm ci" if lock else "npm install") + " --no-audit --no-fund"
    else:
        return None  # bun and others: the model works it out
    if where:
        setup = f"cd {shlex.quote(where)} && {setup}"
    deps = {**dependencies(root), **dependencies(package)}
    script = str((package.get("scripts") or {}).get("test") or ((root or {}).get("scripts") or {}).get("test") or "")
    named = [n for n in RUNNERS if re.search(rf"(^|[\s/&;|]){n}\b", script)] + [n for n in RUNNERS if n in deps]
    if named:
        run = RUNNERS[named[0]]
    elif re.search(r"\bnode\b[^&;|]*--test\b", script):
        run = "node --test"
    else:
        return None
    if not home:
        return {"setup": setup, "test": f"{BINS} && {run} {{test_files}}", "scope": "the PR's changed test files"}
    # From the package's folder, its test files are named from there.
    files = f'$(for f in {{test_files}}; do printf "%s " "${{f#{home}/}}"; done)'
    return {"setup": setup, "test": f"{BINS} && cd {shlex.quote(home)} && {BINS} && {run} {files}",
            "scope": "the PR's changed test files"}


def lock_of(names: set[str], folder: str) -> tuple[str, str] | None:
    return next(((f, m) for f, m in LOCKFILES if posixpath.join(folder, f) in names), None)


def json_file(read, path: str) -> dict | None:
    try:
        data = json.loads(read(path) or "")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def dependencies(package: dict | None) -> dict:
    package = package or {}
    return {**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})}


# Proving commands.

@dataclass
class Proof:
    passed: bool
    step: str    # where it stopped ("setup", "apply", "tests" or "sandbox"); "" when it passed
    output: str  # the end of that step's output


PASSED = re.compile(r"\b(\d+) (?:tests? )?(?:passed|passing|pass)\b|^\s*[#ℹ] pass (\d+)|test result: \w+\. (\d+) passed",
                    re.M | re.I)
NO_TESTS = re.compile(r"no tests? (?:files? )?(?:found|ran|to run)|no test files|running 0 tests|collected 0 items|"
                      r"# tests 0|no test suite found", re.I)
GO_PASSED = re.compile(r"^ok\s+\S+", re.M)


def ran_tests(output: str) -> bool:
    """Whether a passing test command ran any tests: a count of passed tests above 0, or, from a
    runner whose counts aren't known here, no word that it found none."""
    counts = [int(next(g for g in m.groups() if g)) for m in PASSED.finditer(output)]
    if any(counts) or GO_PASSED.search(output):
        return True
    return not counts and not NO_TESTS.search(output)


def runnable(task: tasks.Task) -> list[str]:
    """What {test_files} becomes for a task: its test sources that exist after the change."""
    return [p for p in task.meta["verifier"].get("test_files") or []
            if (task.path / "tests" / "files" / p).is_file() and tasks.SOURCE_FILE.search(p)]


def with_commands(task: tasks.Task, setup: str, template: str, scope: str | None = None) -> tasks.Task:
    verifier = {**task.meta["verifier"], "test_template": template,
                "test": template.replace("{test_files}", " ".join(map(shlex.quote, runnable(task))))}
    if scope:
        verifier["scope"] = scope
    return replace(task, meta={**task.meta, "environment": {**task.meta["environment"], "setup": setup},
                               "verifier": verifier})


def retarget(task: tasks.Task, setup: str, template: str) -> tasks.Task:
    """Rewrite a task folder for other commands; its check runs again."""
    new = with_commands(task, setup, template, "the PR's changed test files" if "{test_files}" in template
                        else "worked out for the repository")
    tasks.write_toml(task.path / "task.toml", new.meta)
    (task.path / "tests" / "test.sh").write_text(tasks.TEST_SH.format(test=new.meta["verifier"]["test"]))
    (task.path / "validation" / "result.json").unlink(missing_ok=True)
    return new


def tail(text: str, chars: int = OUTPUT_CHARS) -> str:
    text = runner.ANSI.sub("", text).strip()
    return text if len(text) <= chars else "..." + text[-chars:]


def prove(task: tasks.Task, setup: str, template: str, settings: runner.Settings, run_id: str, log_dir: Path) -> Proof:
    """As the check runs a task, in a fresh sandbox: install at the base, apply the merged change, then
    the test command on the PR's test files. It has to pass, and run tests."""
    trial = with_commands(task, setup, template)
    container = runner.container_name(run_id)
    log_dir.mkdir(parents=True, exist_ok=True)
    try:
        runner.start_container(container, run_id, settings, runner.sandbox_memory(task, settings))
        reason, _ = runner.prepare_workspace(container, trial, log_dir, "the command check's")
        if reason:
            log = log_dir / "setup.log"
            said = log.read_text(errors="replace") if log.is_file() else ""
            return Proof(False, "setup", ("(timed out) " if reason == "setup-timeout" else "") + tail(said or reason))
        runtime.upload(container, task.path / "tests", "/tests")
        runtime.upload(container, task.path / "solution" / "reference.patch", "/tmp/reference.patch")
        code, out, _ = runner.sh(container, "git apply --whitespace=nowarn /tmp/reference.patch", timeout=120)
        if code:
            return Proof(False, "apply", tail(out))
        timeout = int(task.meta["verifier"].get("timeout_sec", 900))
        code, out, timed_out = runner.sh(container, tasks.TEST_SH.format(test=trial.meta["verifier"]["test"]),
                                         timeout=timeout)
        (log_dir / "tests.log").write_text(out)
        if timed_out:
            return Proof(False, "tests", f"(timed out after {timeout} s) " + tail(out))
        if code:
            return Proof(False, "tests", f"(exit {code}) " + tail(out))
        if not ran_tests(out):
            return Proof(False, "tests", "(exit 0, but it ran no tests) " + tail(out))
        return Proof(True, "", tail(out))
    except (runtime.RuntimeError, OSError) as exc:
        return Proof(False, "sandbox", f"the sandbox failed: {exc}")
    finally:
        try:
            runtime.delete(container)
        except runtime.RuntimeError:
            pass  # labelled with the run: its cleanup removes it


class Bench:
    """A scratch sandbox the model looks around in: the merged commit, nothing installed, with network."""

    def __init__(self, task: tasks.Task, settings: runner.Settings, run_id: str):
        self.task, self.settings, self.run_id, self.name = task, settings, run_id, None

    def run(self, command: str) -> str:
        try:
            if not self.name:
                self.name = runner.container_name(self.run_id)
                runner.start_container(self.name, self.run_id, self.settings, runner.sandbox_memory(self.task, self.settings))
                runtime.upload(self.name, tasks.snapshot(self.task), "/tmp/source.tar.gz")
                runtime.upload(self.name, self.task.path / "solution" / "reference.patch", "/tmp/reference.patch")
                code, out, _ = runner.sh(self.name, "tar -xzf /tmp/source.tar.gz -C /workspace && rm /tmp/source.tar.gz "
                                                    "&& git init -q -b main && git apply --whitespace=nowarn /tmp/reference.patch",
                                         timeout=300)
                if code:
                    return f"the scratch copy couldn't be made: {tail(out, 1000)}"
            code, out, timed_out = runner.sh(self.name, command, timeout=RUN_SECONDS, network=True)
        except (runtime.RuntimeError, OSError) as exc:
            return f"the sandbox failed: {exc}"
        return f"exit {code}{' (timed out)' if timed_out else ''}\n{tail(out)}"

    def read(self, path: str) -> str:
        return self.run(f"head -c 12000 -- {shlex.quote(path.lstrip('/'))}")

    def close(self) -> None:
        if self.name:
            try:
                runtime.delete(self.name)
            except runtime.RuntimeError:
                pass


# The model loop.

SYSTEM = """You work out the commands that install a repository's dependencies and run its tests, for a harness that grades code changes.

For each pull request the harness takes a fresh Linux sandbox (Debian bookworm with Node 24 and corepack, Go, Python 3.12 with uv, git and curl; no Rust, no Java) and, as an unprivileged user with HOME=/home/agent, in /workspace:
1. unpacks the repository at the pull request's base commit and runs the install command, with network, 15 minutes at most;
2. applies the pull request (its code and its tests) and runs the test command, without network, 15 minutes at most. In the test command, {test_files} becomes the pull request's test files: paths from the repository root, shell-quoted, separated by spaces.

The commands are right when the install succeeds and the test command runs the pull request's tests and exits 0 because they pass. Run just those tests where the runner allows it: a whole suite is slow and fails for unrelated reasons. Follow the repository's own way: its CI workflow, package manager, lockfile and test runner. Keep installs frozen to the lockfile. Install a toolchain the sandbox lacks in the install command, under $HOME. Nothing at test time can download anything. No watch mode, no coverage.

Each turn, answer with exactly one JSON object, one of:
{"action": "read", "path": "<path from the repository root>"}   shows a file, with the pull request applied
{"action": "run", "command": "<shell command>"}   runs in a scratch copy of the repository with the pull request applied, from /workspace, with network, 10 minutes at most; nothing is installed there until you install it
{"action": "try", "setup": "<install command>", "test": "<test command, with {test_files}>"}   proves the two commands in a fresh sandbox exactly as the harness runs them, and says how it went
{"action": "give_up", "reason": "<why>"}

You have TRIES tries and TURNS answers in all, so look before you try."""


class Unsolved(Exception):
    def __init__(self, why: str, tried: list, spent: float):
        super().__init__(why)
        self.why, self.tried, self.spent = why, tried, spent


def parse(text: str) -> dict:
    match = re.search(r"\{.*\}", text or "", re.S)
    try:
        found = json.loads(match[0]) if match else None
    except ValueError:
        return {}
    return found if isinstance(found, dict) else {}


def loop(context: str, *, ask, run, read, prove, fixed: dict | None = None, say=lambda text: None,
         tries: int = TRIES, turns: int = TURNS, budget: float = BUDGET_USD, start: int = 0) -> dict:
    """Ask the model for commands until a try passes. `ask(messages)` gives (answer, usd); `run(command)`
    and `read(path)` give text from the scratch sandbox; `prove(setup, test)` a Proof. `fixed` holds a
    command that was given, which every try keeps; `start` counts tries made before it, for what `say` tells.
    Returns {setup, test, tried, spent}; raises Unsolved."""
    fixed = fixed or {}
    system = SYSTEM.replace("TRIES", str(tries)).replace("TURNS", str(turns))
    messages = [{"role": "system", "content": system}, {"role": "user", "content": context}]
    tried: list = []
    spent = 0.0
    for turn in range(turns):
        if spent > budget:
            raise Unsolved(f"it reached its ${budget:.2f} limit", tried, spent)
        text, usd = ask(messages)
        spent += usd or 0.0
        messages.append({"role": "assistant", "content": text})
        action = parse(text)
        kind = action.get("action")
        if kind == "try":
            setup = fixed.get("setup") or str(action.get("setup") or "").strip()
            test = fixed.get("test") or str(action.get("test") or "").strip()
            if not setup or not test:
                reply = "A try needs both commands, setup and test."
            else:
                say(f"trying install `{short(setup)}` (try {start + len(tried) + 1} of {start + tries})")
                proof = prove(setup, test)
                tried.append((setup, test, proof))
                if proof.passed:
                    return {"setup": setup, "test": test, "tried": tried, "spent": spent}
                if proof.step == "sandbox":  # not the commands' fault: another try would fail the same way
                    raise Unsolved("the sandbox failed, not the commands", tried, spent)
                if len(tried) >= tries:
                    raise Unsolved(f"none of its {tries} tries passed", tried, spent)
                reply = f"That failed at {proof.step} ({tries - len(tried)} tries left):\n{proof.output}"
        elif kind == "run" and str(action.get("command") or "").strip():
            say(f"looking around: `{short(str(action['command']))}`")
            reply = run(str(action["command"]))
        elif kind == "read" and str(action.get("path") or "").strip():
            reply = read(str(action["path"]))
        elif kind == "give_up":
            raise Unsolved(f"the model gave up: {str(action.get('reason') or '')[:300]}", tried, spent)
        else:
            reply = 'Answer with one JSON object whose "action" is read, run, try or give_up.'
        messages.append({"role": "user", "content": f"{reply}\n\n({turns - turn - 1} answers left)"})
    raise Unsolved(f"it ran out of its {turns} answers", tried, spent)


def short(command: str, chars: int = 70) -> str:
    command = " ".join(command.split())
    return command if len(command) <= chars else command[:chars - 1] + "…"


def chat(model: config.Model, trial_dir: Path):
    """ask() for the loop: Chat Completions on the model's provider, each answer charged to the run."""
    url = config.PROVIDER_URLS[model.provider]
    key = os.environ.get(config.API_KEYS.get(model.provider, ""), "")

    def ask(messages: list[dict]) -> tuple[str, float]:
        body = json.dumps({"model": model.model, "messages": messages, "max_tokens": 4000,
                           "response_format": {"type": "json_object"}}).encode()
        request = urllib.request.Request(f"{url}/chat/completions", data=body, headers={
            "authorization": f"Bearer {key}", "content-type": "application/json"})
        last = None
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=CHAT_TIMEOUT) as response:
                    data = json.loads(response.read())
                usd = model.price_call(model.model, meter.usage_counts("chat", data.get("usage") or {}))
                charge(trial_dir, "commands", model.key, usd)
                return data["choices"][0]["message"].get("content") or "", usd or 0.0
            except urllib.error.HTTPError as exc:
                last = f"HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}"
                if exc.code < 500 and exc.code != 429:
                    break
            except (OSError, ValueError, KeyError, IndexError) as exc:
                last = str(exc) or type(exc).__name__
            time.sleep(min(3 * 2 ** attempt, 30))
        raise runtime.RuntimeError(f"{model.label} didn't answer ({last})")
    return ask


# What the model reads first: the files that say how the repository builds and tests.
TELLING = re.compile(r"(^|/)(package\.json|pnpm-workspace\.yaml|\.yarnrc\.yml|\.nvmrc|\.node-version|\.tool-versions|"
                     r"lerna\.json|nx\.json|turbo\.json|Cargo\.toml|rust-toolchain(\.toml)?|go\.mod|pyproject\.toml|"
                     r"setup\.py|setup\.cfg|tox\.ini|noxfile\.py|Makefile|justfile|CONTRIBUTING\.md|"
                     r"(vitest|jest|vite)\.config\.[cm]?[jt]s|\.mocharc\.[a-z]+)$")
SHOWN = ("package.json", "pnpm-workspace.yaml", ".nvmrc", ".node-version", "rust-toolchain", "rust-toolchain.toml",
         "Cargo.toml", "go.mod", "pyproject.toml", "Makefile", "justfile", "CONTRIBUTING.md")


def context(repo: str, task: tasks.Task, paths: list[str], read, first: tuple | None, fixed: dict) -> str:
    """The model's first message: the PR, the repository's telling files, and how the first guess went."""
    meta = task.meta["task"]
    files = runnable(task)
    lines = [f"Repository: {repo} ({meta.get('language') or 'unknown language'})",
             f"Pull request #{meta['pr_number']}: {meta['title']}",
             "Its test files, what {test_files} becomes: " + (" ".join(files) or "(none; the test command runs the suite)"),
             "", "Top-level files: " + " ".join(sorted({p.split("/")[0] + ("/" if "/" in p else "") for p in paths})[:80])]
    telling = [p for p in paths if (TELLING.search(p) and p.count("/") <= 3) or p.startswith(".github/workflows/")]
    lines += ["Files that say how it builds and tests:", *[f"  {p}" for p in telling[:150]]]
    homes = {posixpath.dirname(f) for f in files}
    shown = [p for p in SHOWN if p in paths]
    shown += [p for p in telling if posixpath.basename(p) == "package.json" and p not in shown
              and any(h.startswith(posixpath.dirname(p)) for h in homes)][:3]
    shown += [p for p in telling if p.startswith(".github/workflows/") and "test" in (read(p) or "").lower()][:3]
    room = 24000
    for path in shown:
        text = (read(path) or "")[:3000]
        if text and room > 0:
            lines += ["", f"== {path} ==", text[:room]]
            room -= len(text)
    if fixed:
        lines += ["", "Given, and kept in every try: " + ", ".join(f"the {k} command `{v}`" for k, v in fixed.items())]
    if first:
        setup, test, proof = first
        lines += ["", f"The first guess was install `{setup}`, test `{test}`. It failed at {proof.step}:", proof.output]
    return "\n".join(lines)


# The run's step.

def settle(job_path: Path, repo: str, mine: list[tasks.Task], settings: runner.Settings, run_id: str, *,
           setup: str | None = None, test: str | None = None, status=lambda text: None, ask=None,
           saved_path: Path | None = None, progress=lambda record: None) -> tuple[dict, list[tasks.Task]]:
    """The install and test commands a run uses for `repo`, and its tasks rewritten for them where they changed.

    Given ones win. A repository with commands of its own in tasks.recipe keeps them, and ones an earlier
    run proved are used as they are (this run's check proves them again). Otherwise they're worked out
    here, on one of its pull requests, and kept for the next run. SystemExit says what was tried when
    nothing works. While they're worked out, `progress` gets each try and what is happening now (Progress).
    """
    if setup and test:
        entry = saved(repo, saved_path)
        same = bool(entry) and (entry["setup"], entry["test"]) == (setup, test)
        return {"setup": setup, "test": test, "source": "saved" if same else "given"}, mine
    if curated(repo):
        return dict(zip(("setup", "test"), used(mine[0]), strict=True)) | {"source": "default"}, mine
    entry = saved(repo, saved_path)
    if entry and all(used(t) == (entry["setup"], entry["test"]) for t in mine):
        return ({k: entry[k] for k in ("setup", "test", "proven_on", "at") if k in entry}
                | {"source": "default" if entry.get("how") == "default" else "saved"}), mine

    # The smallest PR whose tests can be named, so its proof is quick.
    task = min(mine, key=lambda t: (not runnable(t), t.meta["task"].get("lines_changed", 0)))
    pr = task.meta["task"]["pr_number"]
    fixed = {k: v for k, v in (("setup", setup), ("test", test)) if v}
    guessed = (fixed.get("setup") or used(task)[0], fixed.get("test") or used(task)[1])
    watch = Progress(repo, pr, TRIES + (guessed[1] != UNKNOWN["test"]), status, progress)
    try:
        found, how, spent, model = work_out(job_path, repo, task, guessed, fixed, settings, run_id, ask, watch)
    except SystemExit as exc:
        watch.end("failed", str(exc.code))
        raise
    watch.end("done")
    entry = {"setup": found[0], "test": found[1], "how": how, "at": now(),
             "proven_on": {"pr": pr, "commit": task.meta["task"].get("reference_sha")}}
    keep(repo, entry, saved_path)
    retargeted = [retarget(t, *found) if used(t) != found else t for t in mine]
    record = {**entry, "source": "default" if how == "default" else "worked out", "tries": len(watch.state["tries"]),
              "cost_usd": round(spent, 4), "model": model.label if model else None}
    return record, retargeted


def work_out(job_path: Path, repo: str, task: tasks.Task, guessed: tuple[str, str], fixed: dict,
             settings: runner.Settings, run_id: str, ask, watch: "Progress") -> tuple:
    """Prove the first guess on `task`, then let the model loop work the commands out if it fails.
    Returns (found, how, spent, model); SystemExit says what was tried when nothing works."""
    pr, language = task.meta["task"]["pr_number"], task.meta["task"].get("language") or ""
    logs = job_path / "commands" / repo.replace("/", "__")

    def prove_here(s: str, t: str) -> Proof:
        watch.proving(s)
        started = time.monotonic()
        proof = prove(task, s, t, settings, run_id, logs / f"try-{len(watch.state['tries'])}")
        watch.proved(proof, time.monotonic() - started)
        return proof

    first, found, how, spent, model = None, None, "", 0.0, None
    if guessed[1] != UNKNOWN["test"]:
        default = tasks.recipe("", language, []) if language in ("Go", "Python") else {}
        how = watch.by = "default" if guessed == (default.get("setup"), default.get("test")) else "guess"
        watch.say(f"trying {'its default commands' if how == 'default' else 'a guess from its files'} on #{pr}")
        proof = prove_here(*guessed)
        first = (*guessed, proof)
        if proof.passed:
            return guessed, how, spent, model
        if proof.step == "sandbox":  # nothing a model could fix
            raise SystemExit(failure(repo, pr, [first], "the sandbox failed, not the commands"))
    catalog, _ = config.load()
    model = catalog[MODEL]
    if not ask and (missing := config.missing_credential(model)):
        raise SystemExit(failure(repo, pr, [first] if first else [], missing))
    watch.by = model.label
    watch.say(f"{model.label} is reading the repository" + (f" (the first guess failed at {first[2].step})" if first else ""))
    mirror = tasks.DEFAULT_REPOS / f"{task.meta['task']['repo'].replace('/', '__')}.git"
    paths, read = files_at(mirror, task.meta["task"]["base_sha"]) if mirror.exists() else ([], lambda p: None)
    bench = watch.bench = Bench(task, settings, run_id)
    try:
        got = loop(context(repo, task, paths, read, first, fixed),
                   ask=ask or chat(model, job_path / "trials" / f"commands-{repo.replace('/', '__')}"),
                   run=bench.run, read=bench.read, prove=prove_here, fixed=fixed, say=watch.say, start=int(bool(first)))
    except Unsolved as exc:
        tried = ([first] if first else []) + exc.tried
        raise SystemExit(failure(repo, pr, tried, exc.why, exc.spent, model.label)) from None
    except runtime.RuntimeError as exc:  # the model couldn't be reached
        raise SystemExit(failure(repo, pr, [first] if first else [], str(exc))) from None
    finally:
        bench.close()
    return (got["setup"], got["test"]), "model", got["spent"], model


class Progress:
    """Working out a repository's commands as the page shows it: each try (who proposed it, its install
    command, where it stopped and the line that says why), what is happening now, and the sandboxes it
    holds. `publish` gets a copy of `state` after every change; `status` the sentence for the run's line."""

    def __init__(self, repo: str, pr: int, of: int, status, publish):
        self.status, self.publish, self.by, self.bench = status, publish, "", None
        self.state = {"repo": repo, "pr": pr, "of": of, "started_at": now(), "state": "working", "now": "",
                      "tries": [], "sandboxes": 0}

    def say(self, text: str) -> None:
        self.state["now"] = text
        self.status(f"Working out how to install and test {self.state['repo']}: {text}")
        self.send()

    def proving(self, setup: str) -> None:
        self.state["tries"].append({"n": len(self.state["tries"]) + 1, "by": self.by, "setup": short(setup, 240),
                                    "started_at": now()})
        self.send()

    def proved(self, proof: Proof, seconds: float) -> None:
        self.state["tries"][-1].update(step="passed" if proof.passed else proof.step, seconds=round(seconds),
                                       error=None if proof.passed else gist(proof.output))
        self.send()

    def end(self, state: str, why: str | None = None) -> None:
        self.state.update(state=state, finished_at=now(), **({"why": why} if why else {}))
        self.send()

    def send(self) -> None:
        working = self.state["state"] == "working"
        tries = self.state["tries"]
        self.state["sandboxes"] = working * ((bool(tries) and "step" not in tries[-1])
                                             + bool(self.bench and self.bench.name))
        self.publish(json.loads(json.dumps(self.state)))


# Lines that say why a command failed, over the counts and banners test runners end with.
SAYS_WHY = re.compile(r"\w(?:Error|Exception)\b:|\berror\b:|command not found|No such file|Permission denied|"
                      r"not found|Cannot find|cannot find|Could not|could not|ENOENT|EACCES", re.I)


def gist(output: str, chars: int = 240) -> str:
    """The line of a failed command's output that best says why: the last one that names an error, else the last."""
    lines = [line.strip() for line in runner.ANSI.sub("", output or "").splitlines() if line.strip()]
    line = next((line for line in reversed(lines) if SAYS_WHY.search(line)), lines[-1] if lines else "")
    return line if len(line) <= chars else line[:chars - 1] + "…"

def failure(repo: str, pr: int, tried: list, why: str, spent: float = 0.0, model: str | None = None) -> str:
    """Why a run stops when nothing worked: what it tried, the last error, and what to do instead."""
    text = f"Couldn't work out how to install and test {repo}"
    if tried:
        setup, test, proof = tried[-1]
        error = gist(proof.output, 300)
        text += (f": {len(tried)} tr{'y' if len(tried) == 1 else 'ies'} on #{pr} failed ({why}). The last was install "
                 f"`{short(setup, 120)}` and test `{short(test, 120)}`, which failed at {proof.step}: {error.strip()}")
    else:
        text += f" ({why})"
    if spent:
        text += f" ({model} cost ${spent:.2f})"
    return text.rstrip(".") + ". Give the install and test commands on the form, or pass --setup and --test."
