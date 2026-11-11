"""Trial sandboxes, on Baseten Sandboxes. The Baseten key never enters a sandbox.

One key does it: BASETEN_SANDBOX_API_KEY, else BASETEN_API_KEY, a personal key or a team creator service
account key (a model-only key can't create sandboxes). BASETEN_TEAM_ID picks the team when the key reaches
more than one.

A team's sandboxes are shared: other people's runs, the hosted page's and other tools' are in the same
list. Every sandbox a run makes is labelled with the run's id and with the machine the run is on, and
only sandboxes carrying both are ever deleted here.

Baseten Sandboxes can't limit a sandbox's network yet, so nothing here does: a trial keeps its agent and
its tests off the network from inside the sandbox (docker/jail.py, runner.py).
"""
from __future__ import annotations

import builtins
import hashlib
import os
import platform
import random
import re
import secrets
import shlex
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from . import baseten

IMAGE_DIR = Path(__file__).resolve().parents[1] / "docker"
# What marks a trial sandbox: its run's id, and the machine that run is on. Two people can start
# same-named runs, so the run's id alone doesn't say whose a sandbox is.
LABEL, ORIGIN_LABEL = "pr-eval", "pr-eval-origin"
ORIGIN = hashlib.sha256(platform.node().encode()).hexdigest()[:12]
# A sandbox in one of these states is already on its way out.
GOING = ("DELETING", "TERMINATED")
IMAGE_FILES = ("Dockerfile", "proxy.py", "jail.py")
DEFAULT_IMAGE = "pr-eval-runner-" + hashlib.sha256(
    b"".join((IMAGE_DIR / f).read_bytes() for f in IMAGE_FILES)
).hexdigest()[:12]
KEYS = ("BASETEN_SANDBOX_API_KEY", "BASETEN_API_KEY")
NO_KEY = ("Trial sandboxes run on Baseten Sandboxes: set BASETEN_API_KEY to a personal key or a team creator "
          "service account key (or BASETEN_SANDBOX_API_KEY, to keep a model-only key in BASETEN_API_KEY).")
# A sandbox deletes itself this long after it was made, whatever became of its run.
MAX_AGE = "6h"
# A team runs only so many sandboxes at once. When it is full, a new one waits for another to finish, this
# long at most, instead of failing its attempt: every run of every person shares the team's count.
QUOTA_WAIT_SEC = 900
QUOTA_FULL = re.compile(r"quota exceeded", re.I)
ENDED = ("completed", "failed", "killed", "stopped")
# The sandbox ends a command at its time limit itself, by its own clock. If it hasn't this long after, by
# this machine's clock, this machine asks it to.
KILL_GRACE_SEC = 30
_LOCK = threading.Lock()
_CLIENT: baseten.Client | None = None
_SANDBOXES: dict[str, dict] = {}


class RuntimeError(builtins.RuntimeError):
    """Infrastructure failure; never a model failure."""


def client() -> baseten.Client:
    global _CLIENT
    with _LOCK:
        if _CLIENT is None:
            key = next((os.environ[name] for name in KEYS if os.environ.get(name)), None)
            if not key:
                raise RuntimeError(NO_KEY)
            _CLIENT = baseten.Client(key, os.environ.get("BASETEN_TEAM_ID") or None)
        return _CLIENT


def check_connection() -> None:
    """The key can make sandboxes: it mints a sandbox token and Baseten lists where they run."""
    try:
        client().manage("GET", "/v1/sandboxes/configuration")
    except baseten.SandboxError as exc:
        if exc.status in (401, 403):
            if client().team:  # Baseten refuses a team the key can't reach the same way
                raise RuntimeError(f"This Baseten key can't create sandboxes in the team in BASETEN_TEAM_ID "
                                   f"({client().team}): check the team's id, or use a key of that team.") from exc
            raise RuntimeError("This Baseten key can't create sandboxes. " + NO_KEY) from exc
        raise RuntimeError("Cannot reach Baseten Sandboxes; check the key and the network.") from exc


def image_name(image: str) -> str:
    """The image's name, from a name or a reference (sandbox/<name>:<tag>)."""
    return image.removeprefix("sandbox/").split(":", 1)[0]


def resolve_image(image: str) -> str:
    """The reference a sandbox is created from. The default image's name is a hash of its source, so its
    latest build is that source's build."""
    return image if ":" in image else f"sandbox/{image}:latest"


def image_exists(image: str) -> bool:
    try:
        return client().image_status(image_name(image)) == "BUILT"
    except baseten.SandboxError as exc:
        raise RuntimeError("Cannot look up the trial image on Baseten.") from exc


def build_image(image: str, claude_code_version: str | None = None) -> int:
    """Build the trial image on Baseten from docker/. Only its source files leave this machine; not the
    repository, tasks, job results or any credential. Returns 0, like a build command."""
    check_connection()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", image):
        raise RuntimeError("Use an image name in lower-case letters, digits and dashes, not a registry tag.")
    files = {name: (IMAGE_DIR / name).read_bytes() for name in IMAGE_FILES}
    if claude_code_version:
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", claude_code_version):
            raise RuntimeError("Claude Code version must be a numeric release.")
        files["Dockerfile"] = re.sub(rb"ARG CLAUDE_CODE_VERSION=.*", f"ARG CLAUDE_CODE_VERSION={claude_code_version}".encode(),
                                     files["Dockerfile"])
    try:
        client().build_image(image, files, memory=8192, timeout=3600)
    except baseten.SandboxError as exc:
        raise RuntimeError(f"The trial image didn't build on Baseten: {exc}") from exc
    return 0


def create(name: str, run_id: str, settings, memory: int | None = None, stopping=lambda: False) -> dict:
    """A sandbox of `memory` MB, or the run's default size, labelled with its run. Waits for room when the
    team's sandbox count is full, unless `stopping()` says the run is ending."""
    body = {"name": name, "image": resolve_image(settings.image), "memory": memory or settings.memory, "region": settings.region,
            "labels": {LABEL: run_id, ORIGIN_LABEL: ORIGIN},
            "lifecycle": {"expiration_policies": [{"type": "TTL_MAX_AGE", "value": MAX_AGE, "action": "DELETE"}]}}
    try:
        waited, told = 0.0, False
        while True:
            try:
                box = client().create(body)
                break
            except baseten.SandboxError as exc:
                if not QUOTA_FULL.search(str(exc)) or waited >= QUOTA_WAIT_SEC or stopping():
                    raise
                if not told:
                    print(f"  Baseten's sandbox count is full ({str(exc)[-80:]}); waiting for one to finish", flush=True)
                    told = True
                pause = random.uniform(10, 20)  # not all at once when one frees
                time.sleep(pause)
                waited += pause
        _SANDBOXES[name] = box
        check = until_ready(lambda: execute(name, "test \"$(id -u)\" != 0 && python3 -c " + shlex.quote(
            "import socket; s=socket.socket(); s.settimeout(2); "
            "code=s.connect_ex(('127.0.0.1',8080)); s.close(); raise SystemExit(code == 0)")
            + " && python3 /opt/eval/jail.py --net none -- true", timeout=30))
        if check.code or check.timed_out:
            raise RuntimeError("Trial image must run non-root, refuse in-sandbox API access and jail a command"
                               + (f": {check.stderr.strip()[-200:]}" if check.stderr.strip() else "."))
        return box
    except Exception as exc:
        # Named creation is not retried: a timeout may still have allocated it.
        # Our own messages say which step failed; anything else is named by type only.
        why = str(exc) if isinstance(exc, RuntimeError) else (
            f"{exc.status}" if isinstance(exc, baseten.SandboxError) and exc.status else type(exc).__name__)
        raise RuntimeError(f"Baseten creation failed for {name} ({why}); use cleanup to reconcile.") from exc


def get(name: str) -> dict:
    if name not in _SANDBOXES:
        try:
            box = client().get(name)
        except baseten.SandboxError as exc:
            raise RuntimeError(f"Could not look up {name} ({exc.status or type(exc).__name__}).") from exc
        if not box or not box.get("url"):
            raise RuntimeError(f"There is no running sandbox {name}.")
        _SANDBOXES[name] = box
    return _SANDBOXES[name]


def twice(transfer):
    """A transfer, and once more if it fails: a dropped upload or download is harmless to repeat,
    and losing the attempt to one is not."""
    try:
        return transfer()
    except Exception:  # noqa: BLE001 - the second try raises whatever is really wrong
        time.sleep(2)
        return transfer()


def until_ready(command):
    """A new sandbox's first command, asked again with backoff if it can't be sent: with many sandboxes
    starting at once, one can answer that its workload isn't ready while it finishes starting.
    Only for commands that are harmless to repeat; each try is a new process."""
    for delay in (1, 2, 4):
        try:
            return command()
        except RuntimeError:
            time.sleep(delay)
    return command()


def upload(name: str, local: Path, remote: str) -> None:
    """A file to `remote`, or a folder's contents into it. A task's source is about 200 MB and an attempt per
    model uploads it at once, so a file goes up from disk in parts and is never whole in memory."""
    box = get(name)

    def transfer():
        if not local.is_dir():
            return client().upload(box, local, remote)
        with tempfile.NamedTemporaryFile(prefix="pr-eval-upload-", suffix=".tar") as packed:
            with tarfile.open(fileobj=packed, mode="w") as tar:
                tar.add(local, arcname=".")
            packed.flush()
            target = "/tmp/upload-" + secrets.token_hex(8) + ".tar"
            client().upload(box, Path(packed.name), target)
        result = execute(name, f"mkdir -p {shlex.quote(remote)} && tar -xf {target} -C {shlex.quote(remote)} && rm {target}", timeout=120)
        if result.code:
            raise RuntimeError("Could not unpack uploaded files.")

    try:
        twice(transfer)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Could not upload {local.name} ({type(exc).__name__}).") from exc


def download(name: str, remote: str, local: Path, *, optional: bool = False) -> None:
    """Copy a sandbox file to `local`, streamed to disk: an agent's log can be tens of MB, and many
    attempts finish at once. An optional file may well not exist, so only a required one is tried twice."""
    def transfer():
        if not client().download(get(name), remote, local):
            raise FileNotFoundError(remote)

    try:
        transfer() if optional else twice(transfer)
    except Exception as exc:
        if not optional:
            raise RuntimeError(f"Could not download {remote}.") from exc


# The most of a command's output, each of stdout and stderr, that comes back from the sandbox: its end,
# where errors and test summaries are. Many attempts run at once, and a chatty install or test run
# can print far more than anyone reads.
OUTPUT_LIMIT = 1 << 20
# What a command keeps of the image's environment: its toolchains. Nothing else is inherited.
KEPT_ENV = ("PATH", "GOPATH", "GOTOOLCHAIN", "UV_PYTHON_INSTALL_DIR", "UV_LINK_MODE", "COREPACK_ENABLE_DOWNLOAD_PROMPT")


def tails(*paths: str) -> str:
    """Shell that writes each file's last OUTPUT_LIMIT bytes to <file>.tail, saying how much it left out."""
    return "; ".join(
        f"s=$(stat -c %s {p} 2>/dev/null || echo 0); {{ [ \"$s\" -le {OUTPUT_LIMIT} ] || "
        f"printf '[%s earlier bytes not kept]\\n' $((s - {OUTPUT_LIMIT})); tail -c {OUTPUT_LIMIT} {p} 2>/dev/null; }} >{p}.tail"
        for p in paths)


@dataclass
class Execution:
    code: int
    stdout: str
    stderr: str
    timed_out: bool = False


def wrapped(script: str, env: dict | None, out: str, err: str, *, replace: bool = False) -> str:
    """`script` under bash with a clean environment: the toolchain variables and `env`, a home of its own,
    and its output in the files `out` and `err`. With `replace`, the shell that starts it becomes it, so
    no parent process is left holding `env`."""
    if any(not re.fullmatch(r"[A-Z_][A-Z0-9_]*", k) for k in (env or {})):
        raise RuntimeError("Invalid environment variable name.")
    variables = " ".join(f'{k}="${{{k}:-}}"' for k in KEPT_ENV)
    forwarded = " ".join(f'{k}="${{{k}}}"' for k in (env or {}))
    # The platform may create root-owned files in the image home. Give the workload a clean, user-owned one.
    return (f"mkdir -p /logs/home && {'exec ' if replace else ''}env -i {variables} {forwarded} HOME=/logs/home CI=1 TZ=UTC "
            f"bash -c {shlex.quote(script)} >{out} " + ("2>&1" if err == out else f"2>{err}"))


def status(box: dict, process: str) -> dict:
    return client().runtime(box, "GET", f"/process/{process}")


def execute(name: str, script: str, *, timeout: int, env: dict | None = None,
            stdout_path: str | None = None, stderr_path: str | None = None) -> Execution:
    """Run `script` in the sandbox as the image's unprivileged user and wait for it, `timeout` seconds at
    most. Only the end of each output comes back (OUTPUT_LIMIT); a caller that names stdout_path reads that
    file itself, with download().

    The sandbox keeps the time, not this machine: it ends the command, and everything the command started,
    `timeout` seconds after it began. So a limit is the same length whether or not the machine watching it
    stalled, slept or was paused meanwhile, and a command cut off at its limit is never taken for one that
    died."""
    box = get(name)
    process = "eval-" + secrets.token_hex(8)
    out = stdout_path or f"/tmp/{process}.out"
    err = stderr_path or f"/tmp/{process}.err"
    wanted = [err] if stdout_path else [out, err]
    command = f"{wrapped(script, env, out, err)}; code=$?; {tails(*wanted)}; exit $code"
    try:
        client().runtime(box, "POST", "/process", body={
            "name": process, "command": command, "workingDir": "/workspace", "env": env or {},
            "waitForCompletion": False, "keepAlive": True, "timeout": max(1, timeout)})
        started = time.monotonic()
        while (state := status(box, process)).get("status") not in ENDED:
            elapsed = time.monotonic() - started
            if elapsed > timeout + KILL_GRACE_SEC:
                client().runtime(box, "DELETE", f"/process/{process}/kill", allow=(404, 409, 422))
                ending = time.monotonic() + 30
                while (state := status(box, process)).get("status") not in ENDED:
                    if time.monotonic() > ending:
                        raise RuntimeError("The sandbox didn't confirm that a timed-out command ended.")
                    time.sleep(0.25)
                break
            time.sleep(0.2 if elapsed < 3 else 0.5 if elapsed < 60 else 1)
        # Nothing but the time limit kills a command: the sandbox at the limit, or this machine just after.
        timed_out = state.get("status") == "killed"
        if timed_out:  # killed before it wrote its tails
            client().exec(box, tails(*wanted), timeout=60)
        read = lambda path: (client().read(box, path + ".tail") or b"").decode(errors="replace")  # noqa: E731
        stdout = "" if stdout_path else read(out)
        code = state.get("exitCode")
        return Execution(-1 if timed_out else (code if code is not None else 1), stdout, read(err), timed_out)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Baseten process transport failed ({type(exc).__name__}).") from exc


def start(name: str, process: str, script: str, *, env: dict | None = None, timeout: int, log: str = "/dev/null") -> None:
    """Start `script` in the sandbox and leave it running, under the name `process`, until stop() or
    `timeout` seconds. Its environment is `env` and the toolchains, like execute()'s, and it is the only
    process that has it: no shell stays behind as its parent."""
    try:
        client().runtime(get(name), "POST", "/process", body={
            "name": process, "command": wrapped(script, env, log, log, replace=True), "workingDir": "/workspace",
            "env": env or {}, "waitForCompletion": False, "keepAlive": True, "timeout": timeout})
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Baseten process transport failed ({type(exc).__name__}).") from exc


def stop(name: str, process: str) -> None:
    """End a process start() began; one that already ended, or a sandbox already gone, is fine."""
    try:
        client().runtime(get(name), "DELETE", f"/process/{process}/kill", allow=(404, 409, 422))
    except (RuntimeError, baseten.SandboxError):
        pass


def delete(name: str) -> None:
    """Delete a sandbox and wait until Baseten says it is going or gone: its processes end with it."""
    try:
        client().delete(name)
        _SANDBOXES.pop(name, None)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            box = client().get(name)
            if not box or box.get("status") in GOING:
                return
            time.sleep(0.25)
        raise RuntimeError(f"Deletion not confirmed for {name}.")
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Could not delete {name} ({type(exc).__name__}).") from exc


def trial_sandboxes() -> dict[str, list[str]]:
    """The trial sandboxes that runs on this machine made and that still exist, by run."""
    try:
        boxes = client().list()
    except baseten.SandboxError as exc:
        raise RuntimeError("Could not list sandboxes on Baseten.") from exc
    found: dict[str, list[str]] = {}
    for box in boxes:
        labels = box.get("labels") or {}
        if labels.get(ORIGIN_LABEL) == ORIGIN and LABEL in labels and box.get("status") not in GOING:
            found.setdefault(labels[LABEL], []).append(box["name"])
    return found


def cleanup(run_id: str) -> list[str]:
    """Delete one run's trial sandboxes: only ones a run of that id on this machine made."""
    removed, failed = [], []
    for name in trial_sandboxes().get(run_id, []):
        # One stuck delete must not leave the rest running until they expire.
        try:
            delete(name)
            removed.append(name)
        except RuntimeError:
            failed.append(name)
    if failed:
        raise RuntimeError(f"Could not delete {', '.join(failed)}; run pr-eval cleanup again.")
    return removed
