"""Deploy the eval page to a Baseten sandbox behind "Sign in with Blaxel".

    .venv/bin/python hosted/deploy.py                  create or update: a release ships only once a real attempt
                                                       passes on it, before and after it serves people
    .venv/bin/python hosted/deploy.py --seed jobs/x    also copy finished runs' reports and traces to the hosted page
    .venv/bin/python hosted/deploy.py --delete         remove the sandbox (add --volume to drop its data too)
    .venv/bin/python hosted/deploy.py --name pr-eval-staging    a copy beside the live page, to try a release on first
    .venv/bin/python hosted/deploy.py --renew          recreate the sandbox when Baseten's 7-day limit is near

Where it runs: Baseten Sandboxes, in the team of the sandbox key below. Trials still run in the dedicated
Blaxel trial workspace (PR_EVAL_BLAXEL_WORKSPACE, else ~/.config/pr-eval/blaxel.json); the deploy stops if
neither is set.

    Image    pr-eval-host-<hash of hosted/Dockerfile>, built on Baseten when missing
    Sandbox  pr-eval-host. Baseten deletes every sandbox 7 days after it was created, whatever its lifecycle
             says, so `--renew` (daily) recreates it once it is 5 days old and no run is going; the data stays
             on the volume. A recreated sandbox can get new preview URLs: the deploy prints them.
    Preview  public HTTPS at a random Baseten host; hosted/server.mjs (@blaxel/sign-in) signs people in and
             is the only public door for people. A second public preview, "meter", is the key meter
             (eval_sandbox/meter.py): trial sandboxes reach the models only through it, and it answers only
             an attempt's ticket
    Volume   pr-eval-host-data at /data: the app (/data/app with its jobs/, tasks/, data/, each release in
             releases/<time>-<commit> and current -> the live one) and the sign-in state (/data/sign-in)
    Release  each deploy's code in a folder of its own. It serves people only once a real attempt passes on it
             (the smoke test, below), and again once it does, else the deploy rolls back. A run going keeps
             the release it started on: a deploy restarts the page, never a run
    Secrets  read on the deploying machine (macOS Keychain or environment) and handed to the page's
             process environment only; never written to the volume, the image or this repository

The deploy itself manages the sandbox with BASETEN_SANDBOX_API_KEY (else the Keychain item in SANDBOX_KEY):
a personal key or a team creator service account key, since other Baseten keys can't mint sandbox tokens.

Keys come from the Keychain items in SECRETS below, else from the environment. <NAME>_KEYCHAIN_ITEM names
another Keychain item for a key, e.g. OPENAI_API_KEY_KEYCHAIN_ITEM=my-openai-key:
    BASETEN_API_KEY         open models and the Kimi K3 judge
    ANTHROPIC_API_KEY       Claude models and the Opus judge
    OPENAI_API_KEY          the GPT-6.1 Sol judge
    BL_API_KEY              a Blaxel service account in the trial workspace
    PR_EVAL_MAIL_API_KEY    optional: a send-only Resend key (Keychain pr-eval-host-mail-api-key). With it the
                            refused sign-in page offers "Request access", which emails the admins; it reaches
                            the sign-in process only. PR_EVAL_MAIL_FROM sets the sender on its verified domain.
    PR_EVAL_ADMINS          optional: comma-separated emails of the first admins, used only when the volume
                            has no access list yet (the first deploy).
    PR_EVAL_GITHUB_TOKEN    a fine-grained GitHub token with "Public repositories" read-only access and nothing
                            else (Keychain pr-eval-host-github-token). With it the page reads and runs public
                            repositories for everyone, no GitHub sign-in needed; without it, every run needs one.

For private repositories, a person signs in with GitHub through the GitHub App "Baseten Eval Sandbox"
(device flow; read-only Contents, Pull requests and Metadata), and the run reads and clones with their
token. Its client id is public: the app's client secret and private key never reach the page. Their tokens
stay in the page's memory.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from eval_sandbox import baseten, pipeline, runtime, tasks, trace  # noqa: E402
WORKSPACE = ""  # set in main() from the same setting local runs use
REGION = "us-pdx-1"
SANDBOX = "pr-eval-host"
VOLUME = "pr-eval-host-data"
VOLUME_SIZE = "30Gi"
IMAGE = "pr-eval-host"
MEMORY = 8192
SANDBOX_KEY = ("BASETEN_SANDBOX_API_KEY", "pr-eval-host-baseten-sandbox-key")
RENEW_AFTER_DAYS = 5  # Baseten deletes a sandbox 7 days after creation
PORT = 3000
PAGE_PORT = 8765
METER_PORT = 8766  # the key meter, in the page's process
# A release's own page and meter, beside the live ones while the smoke test tries it before anyone gets it.
NEXT_PAGE_PORT = 8767
NEXT_METER_PORT = 8768
APP = "/data/app"  # what runs share across releases: jobs/, tasks/, data/; and current -> releases/<id>
RELEASES = f"{APP}/releases"
CURRENT = f"{APP}/current"
SHARED = ["jobs", "tasks", "data"]  # linked into each release, where its code looks for them
KEEP_RELEASES = 3  # besides the live one and any a process still runs from
# The smoke test: one real attempt end to end, on the quick sample's largest task with the cheapest default
# model, graded by the default judges. A release must pass it before people get it and again once they have.
SMOKE_MODEL = "deepseek-v4.1-flash-1017-fast"
# The agent stops after this many seconds, as at any time limit: its change so far gets the hidden tests and the
# judges. Left to finish, it ran PostHog's tests and type checks for 21 minutes.
SMOKE_AGENT_SECONDS = 360
SMOKE_TIMEOUT = 1800  # seconds for the whole attempt: sandboxes, install, agent, hidden tests, judges
SMOKE_OWNER = "deploy-smoke"
LABELS = {"app": "pr-eval-host"}
# The GitHub App's client id is public by design (device flow); it is not a secret.
GITHUB_CLIENT_ID = os.environ.get("PR_EVAL_GITHUB_CLIENT_ID", "Iv23liQbVPW7Rbr3qQJC")
GITHUB_APP = os.environ.get("PR_EVAL_GITHUB_APP", "baseten-eval-sandbox")  # its slug: github.com/apps/<slug>
# One workspace and one set of keys serve everyone: runs going at once, in all and per person, and what runs
# spent on models in the last 24 hours, in all and per person (a quick sample is about $12 with its judges).
LIMITS = {name: os.environ.get(name, default) for name, default in {
    "PR_EVAL_MAX_RUNS": "2", "PR_EVAL_RUNS_PER_PERSON": "1",
    "PR_EVAL_SPEND_TOTAL": "1000", "PR_EVAL_SPEND_PER_PERSON": "500"}.items()}
# Days a run on a private repository keeps its transcripts after it ends; unset keeps them.
RETENTION = {name: os.environ[name] for name in ["PR_EVAL_PRIVATE_RETENTION_DAYS"] if os.environ.get(name)}
# The release: everything the page and its runs read from the repository.
# The sign-in server (hosted/public.mjs) serves the app's own stylesheet and texture before sign-in.
RELEASE = ["eval_sandbox", "configs", "docker", "hosted", "pyproject.toml",
           "web/src/styles/baseten.css", "web/src/styles/texture.png"]
# A run's summary reaches the hosted page, and each attempt's condensed, redacted trace:
# no raw transcripts or logs.
SEED_FILES = ["run.json", "report.json", "report.html"]
# The sign-in server's package ships inside the release as installed here (`npm ci` in hosted/), so the
# sandbox never needs a GitHub Packages token.
SIGN_IN = ROOT / "hosted" / "node_modules" / "@blaxel" / "sign-in"
AUTH = "/data/sign-in"
# Who may sign in, on the volume beside the runs. The sign-in server gets this path, not the release's own
# data/ link to it: @blaxel/sign-in keys its sessions to the access file's path, so a path that changed with
# each release would sign everyone out on every deploy.
ACCESS = f"{APP}/data/access.json"
SECRETS = {
    "BASETEN_API_KEY": "pr-eval-host-baseten-api-key",
    "ANTHROPIC_API_KEY": "pr-eval-host-anthropic-api-key",
    "OPENAI_API_KEY": "pr-eval-host-openai-api-key",
    "BL_API_KEY": "pr-eval-host-blaxel-api-key",
}
# Optional, and for the sign-in process only: without it the refused page has no "Request access".
MAIL_KEY = ("PR_EVAL_MAIL_API_KEY", "pr-eval-host-mail-api-key")
# Optional: the page's own public-only GitHub token. Without it, public repositories need a GitHub sign-in too.
GITHUB_TOKEN = ("PR_EVAL_GITHUB_TOKEN", "pr-eval-host-github-token")
MAIL_FROM = os.environ.get("PR_EVAL_MAIL_FROM", "Eval Sandbox <eval-sandbox@notifications.blaxel.ai>")
LEAK = trace.SECRET


def step(message: str) -> None:
    print(f"\n▸ {message}", flush=True)


def item(name: str, default: str) -> str:
    """The Keychain item that holds a key: its default name, or the one <NAME>_KEYCHAIN_ITEM sets."""
    return os.environ.get(f"{name}_KEYCHAIN_ITEM") or default


def keychain(service: str) -> str | None:
    try:
        p = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True)
    except FileNotFoundError:  # not a Mac
        return None
    return p.stdout.strip() or None


def secrets() -> dict[str, str]:
    # The page's own Keychain items come first, so a key exported in the shell for local runs never reaches it.
    found = {name: keychain(item(name, service)) or os.environ.get(name) for name, service in SECRETS.items()}
    if missing := [name for name, value in found.items() if not value]:
        raise SystemExit(f"missing {', '.join(missing)}: see the top of hosted/deploy.py")
    return found


CLIENT: baseten.Client | None = None


def client() -> baseten.Client:
    global CLIENT
    if CLIENT is None:
        name, service = SANDBOX_KEY
        key = os.environ.get(name) or keychain(item(name, service))
        if not key:
            raise SystemExit(f"missing {name} (Keychain {item(name, service)}): a Baseten personal key or team creator "
                             "service account key, which can mint sandbox tokens")
        CLIENT = baseten.Client(key, os.environ.get("BASETEN_TEAM_ID") or None)
    return CLIENT


def run(sandbox: dict, command: str, timeout: int = 300) -> str:
    code, out, err = client().exec(sandbox, f"sh -c {shlex.quote('set -eu' + chr(10) + command)}", timeout=timeout)
    if code:
        raise SystemExit(f"sandbox command failed ({code}): {(err or out or '')[-2000:]}")
    return out


def image() -> str:
    """The page's image, named by a hash of hosted/Dockerfile, built on Baseten when it isn't yet."""
    dockerfile = (ROOT / "hosted" / "Dockerfile").read_bytes()
    name = f"{IMAGE}-{hashlib.sha256(dockerfile).hexdigest()[:10]}"
    if client().image_status(name) == "BUILT":
        return f"sandbox/{name}:latest"
    step(f"Building image {name} on Baseten (a few minutes, once)")
    return client().build_image(name, {"Dockerfile": dockerfile}, memory=MEMORY)


def host(renew: bool = False):
    client().volume(VOLUME, VOLUME_SIZE, REGION)
    sandbox = client().get(SANDBOX)
    created = False
    if sandbox and sandbox.get("status") in ("FAILED", "TERMINATED"):
        # A create that failed (e.g. a 500) leaves a record with no workload behind it; nothing can serve from it.
        step(f"Sandbox {SANDBOX} is {sandbox['status']}; recreating it")
        delete(volume=False)
        sandbox = None
    if sandbox and renew:
        age = (time.time() - datetime.fromisoformat(sandbox["created_at"].replace("Z", "+00:00")).timestamp()) / 86400
        if age < RENEW_AFTER_DAYS:
            print(f"sandbox {SANDBOX} is {age:.1f} days old; renewing after {RENEW_AFTER_DAYS}")
        elif busy(sandbox):
            print(f"sandbox {SANDBOX} is {age:.1f} days old but a run is going; renewing on the next try")
        else:
            step(f"Recreating sandbox {SANDBOX} ({age:.1f} days old; Baseten deletes it at 7)")
            delete(volume=False)
            sandbox = None
    if not sandbox:
        step(f"Creating sandbox {SANDBOX} with volume {VOLUME} at /data")
        sandbox = client().create({
            "name": SANDBOX, "image": image(), "memory": MEMORY, "region": REGION, "labels": LABELS,
            "ports": [{"name": "web", "protocol": "HTTP", "target": PORT},
                      {"name": "meter", "protocol": "HTTP", "target": METER_PORT}],
            "volumes": [{"name": VOLUME, "mount_path": "/data", "read_only": False}],
            "lifecycle": {"expiration_policies": [{"type": "TTL_IDLE", "value": "30d", "action": "DELETE"},
                                                  {"type": "TTL_MAX_AGE", "value": "52w", "action": "DELETE"}]},
        })
        ready(sandbox)
        created = True
    # The sign-in server owns sign-in, so the preview itself is public.
    origin = client().preview(SANDBOX, "web", PORT)
    # The meter checks every call's ticket itself; the sign-in has no part in it.
    meter = client().preview(SANDBOX, "meter", METER_PORT)
    return sandbox, origin, meter, created


# Prints yes when a process's argv is `python -m eval_sandbox run ...` (what the page starts), the way
# hosted/server.mjs checks; matching command-line text would also match the check itself.
BUSY = """import os
def argv(pid):
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().split(b"\\0")[1:4]
    except OSError:
        return []
print("yes" if any(argv(p) == [b"-m", b"eval_sandbox", b"run"] for p in os.listdir("/proc") if p.isdigit()) else "no")
"""


def busy(sandbox: dict) -> bool:
    """Whether a `pr-eval run` is going in the sandbox."""
    try:
        return "yes" in run(sandbox, f"/opt/venv/bin/python -c {shlex.quote(BUSY)}", timeout=60)
    except SystemExit:
        return False


def ready(sandbox: dict) -> None:
    """A new sandbox can refuse commands for a while after it is created."""
    for wait in (1, 2, 4, 8, 15, 30, 30):
        try:
            if client().exec(sandbox, "true", timeout=30)[0] == 0:
                return
        except baseten.SandboxError:
            pass
        time.sleep(wait)
    raise SystemExit(f"sandbox {SANDBOX} didn't start")


def upload(sandbox: dict, files: dict[str, bytes], remote: str) -> None:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(content), 0o644, int(time.time())
            tar.addfile(info, io.BytesIO(content))
    # The sandbox's own filesystem is held in memory: stage on the volume.
    target = f"/data/.upload-{os.getpid()}-{int(time.time())}.tgz"
    client().write(sandbox, target, archive.getvalue())
    run(sandbox, f"mkdir -p {shlex.quote(remote)} && tar -xzf {target} -C {shlex.quote(remote)} && rm {target}")


def sign_in_package() -> list[Path]:
    """The installed @blaxel/sign-in, checked against the lockfile's version."""
    locked = json.loads((ROOT / "hosted" / "package-lock.json").read_text())["packages"]["node_modules/@blaxel/sign-in"]
    installed = SIGN_IN / "package.json"
    if not installed.is_file() or json.loads(installed.read_text()).get("version") != locked["version"]:
        raise SystemExit(f'@blaxel/sign-in {locked["version"]} is not installed: cd hosted && NODE_AUTH_TOKEN="$(gh auth token)" npm ci')
    return sorted(f for f in SIGN_IN.rglob("*") if f.is_file())


def release_files() -> dict[str, bytes]:
    out = {}
    for entry in RELEASE:
        path = ROOT / entry
        for file in [path] if path.is_file() else sorted(path.rglob("*")):
            if file.is_file() and not {"__pycache__", "node_modules"} & set(file.parts) and not file.name.startswith("."):
                out[str(file.relative_to(ROOT))] = file.read_bytes()
    for file in sign_in_package():
        out[str(file.relative_to(ROOT))] = file.read_bytes()
    return out


def copy_quick_tasks(sandbox) -> str:
    """The quick sample's task folders, collected here first where missing (with the local `gh` login). On the
    page they let a signed-in person with no GitHub account run the quick sample: its runs only read them.
    Each holds its repository's source (about 200 MB for a large one), so only folders the page lacks go,
    one at a time. Returns the task with the largest source, which the smoke test runs."""
    have = set(run(sandbox, f"mkdir -p {APP}/tasks && cd {APP}/tasks && ls -d */task.toml 2>/dev/null | cut -d/ -f1 || true").split())
    largest, size = "", -1
    for repo, prs in tasks.sample(True).items():
        for folder in tasks.collect(repo, prs=prs):
            source = folder / "environment" / "source.tar.gz"
            if source.is_file() and source.stat().st_size > size:
                largest, size = folder.name, source.stat().st_size
            if folder.name in have:
                continue
            print(f"  {folder.name}", flush=True)
            upload(sandbox, {str(file.relative_to(tasks.DEFAULT_TASKS.parent)): file.read_bytes()
                             for file in sorted(f for f in folder.rglob("*") if f.is_file())}, APP)
    if not largest:
        raise SystemExit("the quick sample has no task with a source archive to smoke-test")
    return largest


def seed_files(jobs: list[Path], keys: dict[str, str]) -> dict[str, bytes]:
    out = {}
    for job in jobs:
        for name in SEED_FILES:
            file = job / name
            if not file.is_file():
                continue
            text = file.read_text(errors="replace")
            if LEAK.search(text) or any(value in text for value in keys.values()):
                raise SystemExit(f"{file} looks like it holds a credential; not uploading it")
            out[f"jobs/{job.name}/{name}"] = file.read_bytes()
        trials = job / "trials"
        for result in sorted(trials.glob("*/result.json")) if trials.is_dir() else []:
            text = result.read_text(errors="replace")
            if LEAK.search(text) or any(value in text for value in keys.values()):
                raise SystemExit(f"{result} looks like it holds a credential; not uploading it")
            out[f"jobs/{job.name}/trials/{result.parent.name}/result.json"] = result.read_bytes()
            if condensed := trace.condense(result.parent):
                text = json.dumps(condensed)
                if LEAK.search(text) or any(value in text for value in keys.values()):
                    raise SystemExit(f"{result.parent}'s trace still looks like it holds a credential; not uploading it")
                out[f"jobs/{job.name}/trials/{result.parent.name}/trace.json"] = text.encode()
    return out


def mail_key() -> str | None:
    name, service = MAIL_KEY
    return keychain(item(name, service)) or os.environ.get(name)


def page_env(keys: dict[str, str], origin: str, meter: str, meter_port: int | None) -> dict[str, str]:
    """The page's process environment, which its runs inherit. With `meter_port`, it also serves the key meter."""
    env = {**keys, "BL_WORKSPACE": WORKSPACE, "PR_EVAL_BLAXEL_WORKSPACE": WORKSPACE, "BL_REGION": REGION,
           "PR_EVAL_PUBLIC_REPOS_ONLY": "1", "PR_EVAL_GITHUB_CLIENT_ID": GITHUB_CLIENT_ID,
           "PR_EVAL_GITHUB_APP": GITHUB_APP, "APP_ORIGIN": origin, **LIMITS, **RETENTION,
           "PR_EVAL_METER_URL": meter, "HOME": "/data/home", "PYTHONUNBUFFERED": "1"}
    if meter_port:
        env["PR_EVAL_METER_PORT"] = str(meter_port)
    name, service = GITHUB_TOKEN
    if token := keychain(item(name, service)) or os.environ.get(name):
        env[name] = token
    return env


def serving(sandbox, port: int, also: str = "") -> None:
    """Waits until the page on `port` answers in the sandbox (and `also`, a check that must pass first)."""
    run(sandbox, f"for i in $(seq 1 60); do {also}curl -s -o /dev/null http://127.0.0.1:{port}/api/state "
                 f"-H 'host: 127.0.0.1:{port}' && exit 0; sleep 1; done; echo 'the page did not start' >&2; exit 1", timeout=90)


def start(sandbox, origin: str, meter: str, keys: dict[str, str], release: str) -> None:
    """Restarts the page and the sign-in server on `release`. A run going keeps going: each is a process of its
    own (`pr-eval run`, in a session of its own) that outlives the page, on the release it started from, which
    the deploy keeps. The new page finds it by the process id in its run.json, and its attempts' calls reach
    the new meter, which reads the same tickets from the volume."""
    for process in client().processes(sandbox):
        if (process.get("name") or "").startswith(("pr-eval-page", "pr-eval-sign-in")) and process.get("status") in ("running", "starting"):
            client().kill(sandbox, process["name"])
    stamp = time.strftime("%Y%m%d-%H%M%S")
    env = page_env(keys, origin, meter, METER_PORT)
    sign_in_env = {"PORT": str(PORT), "PR_EVAL_PORT": str(PAGE_PORT), "APP_ORIGIN": origin, "BLAXEL_ENV": "prod",
                   "AUTH_STATE_DIR": AUTH, "AUTH_ACCESS_FILE": ACCESS, "BL_SANDBOX_API": "http://localhost:8080", "NODE_ENV": "production"}
    name, service = GITHUB_TOKEN
    print(f'Public repositories without a GitHub sign-in: {"on" if name in env else "off (no " + service + ")"}')
    if admins := os.environ.get("PR_EVAL_ADMINS"):  # the first admins, used only when there is no access list yet
        sign_in_env["PR_EVAL_ADMINS"] = admins
    if key := mail_key():
        sign_in_env |= {MAIL_KEY[0]: key, "PR_EVAL_MAIL_FROM": MAIL_FROM}
    print(f'"Request access": {"on" if key else "off (no " + MAIL_KEY[1] + ")"}')
    client().start(sandbox, f"pr-eval-page-{stamp}", cwd=release, env=env,
                   command=f"sh -c 'mkdir -p /data/home && exec /opt/venv/bin/python -m eval_sandbox serve --no-open --port {PAGE_PORT} --jobs {APP}/jobs'")
    client().start(sandbox, f"pr-eval-sign-in-{stamp}", cwd=f"{release}/hosted", env=sign_in_env,
                   command="node --disable-warning=ExperimentalWarning server.mjs")
    serving(sandbox, PAGE_PORT, also=f"curl -s -o /dev/null http://127.0.0.1:{PORT}/login && ")


# ---------- releases: each in a folder of its own, so a run going keeps the code it started with ----------

def new_release(sandbox, files: dict[str, bytes]) -> str:
    """Uploads the release to releases/<time>-<commit>, with the shared folders linked in; returns its path."""
    git = lambda *a: subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    commit = git("rev-parse", "--short", "HEAD") or "nogit"
    dirty = "-dirty" if git("status", "--porcelain", "--untracked-files=no") else ""
    release = f"{RELEASES}/{time.strftime('%Y%m%d-%H%M%S')}-{commit}{dirty}"
    run(sandbox, f"mkdir -p {AUTH} {RELEASES} " + " ".join(f"{APP}/{d}" for d in SHARED) + f" && chmod 700 {AUTH}")
    upload(sandbox, files, release)
    run(sandbox, " && ".join(f"ln -sfn {APP}/{d} {release}/{d}" for d in SHARED))
    return release


def live_release(sandbox) -> str | None:
    """The release the page runs now: where `current` points; the app folder itself, where deploys before
    releases put the code; or None on a new sandbox."""
    return run(sandbox, f"readlink {CURRENT} || {{ test -d {APP}/eval_sandbox && echo {APP}; }} || true").strip() or None


def switch(sandbox, release: str) -> None:
    if release == APP:  # back to the code deploys before releases left in the app folder
        run(sandbox, f"rm -f {CURRENT}")
    else:
        run(sandbox, f"ln -sfn {release} {CURRENT}.next && mv -T {CURRENT}.next {CURRENT}")


# Prints the release folders to remove: all but the newest few, the live one and any a process runs from (its
# working directory); then the code deploys before releases left in the app folder, once nothing runs from it.
UNUSED = """import os, sys
releases, current, app, keep, legacy = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5:]
used = set()
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        used.add(os.readlink(f"/proc/{pid}/cwd"))
    except OSError:
        pass
inside = lambda path: any(u == path or u.startswith(path + "/") for u in used)
live = os.path.realpath(current)
for name in sorted(os.listdir(releases), reverse=True)[keep:]:
    path = os.path.join(releases, name)
    if path != live and not inside(path):
        print(path)
if os.path.islink(current) and app not in used and not inside(os.path.join(app, "hosted")):
    print(*(os.path.join(app, n) for n in legacy if os.path.exists(os.path.join(app, n))))
"""


def prune(sandbox) -> None:
    unused = run(sandbox, f"/opt/venv/bin/python -c {shlex.quote(UNUSED)} {RELEASES} {CURRENT} {APP} {KEEP_RELEASES} "
                          + " ".join(RELEASE)).split()
    if unused:
        run(sandbox, "rm -rf " + " ".join(shlex.quote(p) for p in unused))
        print(f"removed {len(unused)} old release folder(s)")


# ---------- the smoke test ----------

class SmokeFailed(Exception):
    pass


def remote_text(sandbox, path: str, limit: int = 1500) -> str:
    try:
        data = client().read(sandbox, path)
    except baseten.SandboxError:
        return ""
    return (data or b"").decode(errors="replace").strip()[-limit:]


def remote_json(sandbox, path: str) -> dict:
    try:
        return json.loads(remote_text(sandbox, path, limit=10**7) or "{}")
    except ValueError:
        return {}


def verdict(meta: dict, result: dict, error: str = "", log: str = "") -> str | None:
    """Why the smoke attempt failed, in plain words, or None when it went end to end: its sandboxes started,
    the task's source went up, the dependencies installed, the agent worked and changed code, the hidden
    tests ran on that change, and the judges answered. Whether the model solved the task doesn't matter."""
    status = meta.get("status") or {}
    if not result:
        return (f"the run ended ({status.get('phase') or 'no status'}) without an attempt result: "
                f"{status.get('detail') or 'see its log'}" + (f"\n{log}" if log else ""))
    outcome, reason = result.get("outcome"), result.get("invalid_reason")
    if outcome == "invalid":
        return f"the attempt was not scored ({reason})" + (f": {error}" if error else "") + (
            f"\nsetup: {json.dumps(result['setup'])[:500]}" if result.get("setup") else "")
    if outcome not in ("solved", "failed"):
        return f"the attempt ended {outcome}"
    if not ((agent := result.get("agent") or {}).get("subtype") or agent.get("timed_out")):
        return "the agent's session ended without an answer"
    if not result.get("tests"):
        return "the hidden tests didn't run"
    if not (result.get("diff") or {}).get("files"):
        return "the agent changed no files, so the judges weren't reached"
    judge = result.get("judge") or {}
    if judge.get("verdict") not in ("pass", "fail"):
        return f"the judges didn't answer: {judge.get('error') or json.dumps(judge)[:300]}"
    return None


def smoke(sandbox, release: str, keys: dict[str, str], origin: str, meter: str, task: str, label: str) -> None:
    """One real attempt with SMOKE_MODEL on `task`, run from `release` through the meter at `meter`, as a run
    the deploy owns and the page doesn't list. Raises SmokeFailed with the attempt's real cause."""
    if SMOKE_MODEL not in pipeline.DEFAULT_MODELS:
        raise SystemExit(f"SMOKE_MODEL {SMOKE_MODEL} is no longer a default model: make it the cheapest default")
    # Short: trial sandboxes are named after the run, and Blaxel refuses a name over 49 characters.
    run_id = f"smoke-{time.strftime('%m%d%H%M%S')}-{label}"
    job = f"{APP}/jobs/{run_id}"
    trial = f"{job}/trials/{task}__{SMOKE_MODEL}__1"
    # An owner, so the meter prices its calls; marked, so the page lists it nowhere and leaves it out of its limits.
    run(sandbox, f"mkdir -p {job} && printf %s {shlex.quote(json.dumps({'owner': SMOKE_OWNER, 'smoke': True}))} > {job}/access.json")
    command = (f"/opt/venv/bin/python -m eval_sandbox run --task {task} --models {SMOKE_MODEL} --name {run_id} "
               f"--agent-timeout {SMOKE_AGENT_SECONDS} "
               f"--jobs {APP}/jobs >> {job}/log.txt 2>&1")
    name = f"pr-eval-{run_id}"
    began = time.time()
    client().runtime(sandbox, "POST", "/process", body={
        "name": name, "command": f"sh -c {shlex.quote(command)}", "waitForCompletion": False,
        "timeout": SMOKE_TIMEOUT, "env": page_env(keys, origin, meter, None), "workingDir": release})
    print(f"{run_id}: {task} with {SMOKE_MODEL}", flush=True)
    said = ""
    while True:
        done = client().runtime(sandbox, "GET", f"/process/{name}").get("status") not in ("running", "starting")
        if done:
            break
        now = (remote_json(sandbox, f"{trial}/stage.json").get("stage")
               or (remote_json(sandbox, f"{job}/run.json").get("status") or {}).get("detail") or "starting")
        if now != said:
            print(f"  {int(time.time() - began):>4}s  {now}", flush=True)
            said = now
        if time.time() - began > SMOKE_TIMEOUT + 120:
            client().kill(sandbox, name)
            raise SmokeFailed(f"the attempt took over {SMOKE_TIMEOUT // 60} minutes (run {job} on the volume)")
        time.sleep(10)
    result = remote_json(sandbox, f"{trial}/result.json")
    why = verdict(remote_json(sandbox, f"{job}/run.json"), result, remote_text(sandbox, f"{trial}/error.log"),
                  remote_text(sandbox, f"{job}/log.txt"))
    spent = sum(float(e.get("usd") or 0) for e in map(json.loads, filter(None, remote_text(
        sandbox, f"{job}/spend.jsonl", limit=10**7).splitlines())))
    took = f"{(time.time() - began) / 60:.1f} min, ${spent:.2f} on models"
    if why:
        raise SmokeFailed(f"{why}\n(run {job} on the volume; {took})")
    print(f"smoke ok: {result['outcome']}, hidden tests {'passed' if result['tests'].get('passed') else 'failed'}, "
          f"judges {result['judge']['verdict']}; {took}", flush=True)


def try_release(sandbox, release: str, keys: dict[str, str], origin: str, task: str) -> None:
    """The smoke test on a release before anyone gets it, through its own page and meter beside the live ones."""
    meter = client().preview(SANDBOX, "meter-next", NEXT_METER_PORT)
    name = f"pr-eval-next-{time.strftime('%Y%m%d-%H%M%S')}"
    client().start(sandbox, name, cwd=release, env=page_env(keys, origin, meter, NEXT_METER_PORT), restarts=0,
                   command=f"sh -c 'mkdir -p /data/home && exec /opt/venv/bin/python -m eval_sandbox serve --no-open --port {NEXT_PAGE_PORT} --jobs {APP}/jobs'")
    try:
        try:
            serving(sandbox, NEXT_PAGE_PORT)
        except SystemExit:
            out = client().runtime(sandbox, "GET", f"/process/{name}")
            raise SmokeFailed(f"the new page didn't start: {((out.get('stderr') or '') + (out.get('stdout') or ''))[-1500:]}")
        smoke(sandbox, release, keys, origin, meter, task, "before")
    finally:
        client().kill(sandbox, name)


def verify(origin: str, meter: str) -> None:
    """The signed-out answers a healthy deploy gives, and the meter refusing a call with no ticket."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect)

    def status(path: str, accept: str = "*/*", base: str = origin) -> int:
        try:
            return opener.open(urllib.request.Request(base + path, headers={"accept": accept}), timeout=30).status
        except urllib.error.HTTPError as exc:
            return exc.code
    got = {"login": status("/login"), "page": status("/", "text/html"), "api": status("/api/state", "application/json"),
           "meter": status("/anthropic/v1/models", base=meter)}
    if got != {"login": 200, "page": 303, "api": 401, "meter": 401}:
        raise SystemExit(f"unexpected signed-out answers {got}; see the pr-eval-page-* and pr-eval-sign-in-* process logs")
    print(f"signed-out answers ok: {got}")


def delete(volume: bool) -> None:
    client().delete(SANDBOX)
    for _ in range(100):  # gone before a deploy can create it afresh
        left = client().get(SANDBOX)
        if not left:
            break
        if left.get("status") == "TERMINATED":
            client().delete(SANDBOX)
        time.sleep(3)
    else:
        raise SystemExit(f"sandbox {SANDBOX} is still there; try again in a minute")
    print(f"deleted sandbox {SANDBOX}")
    # The volume stays attached for a few seconds after the sandbox is gone; a create that mounts it before then
    # fails with a 500 and leaves a FAILED sandbox (Nov 11 renew).
    for _ in range(100):
        if not client().manage("GET", f"/v1/sandboxes/volumes/{VOLUME}", allow=(404,)).get("attached_to"):
            break
        time.sleep(3)
    else:
        raise SystemExit(f"volume {VOLUME} is still attached; try again in a minute")
    if volume:
        for _ in range(60):
            try:
                client().manage("DELETE", f"/v1/sandboxes/volumes/{VOLUME}", allow=(404,))
                print(f"deleted volume {VOLUME}")
                return
            except baseten.SandboxError:  # still attached while the sandbox shuts down
                time.sleep(2)
        raise SystemExit(f"could not delete volume {VOLUME}; try again in a minute")


def workspace() -> str:
    try:
        return runtime.workspace()
    except runtime.RuntimeError as exc:
        raise SystemExit(f"{exc} Or save it in {runtime.CONFIG_PATH}.") from None


def main() -> int:
    global WORKSPACE, SANDBOX, VOLUME
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=Path, nargs="*", default=[], help="finished runs to show on the hosted page")
    parser.add_argument("--delete", action="store_true", help="remove the hosted sandbox")
    parser.add_argument("--volume", action="store_true", help="with --delete, also remove its data")
    parser.add_argument("--renew", action="store_true", help="recreate the sandbox and deploy again only when it is "
                        f"{RENEW_AFTER_DAYS}+ days old and no run is going (Baseten deletes it at 7); else do nothing")
    parser.add_argument("--name", default=SANDBOX, help="another copy, pr-eval-<something>: its own sandbox, "
                        "volume (<name>-data), sign-in and previews")
    args = parser.parse_args()
    if args.name != SANDBOX:
        if not re.fullmatch(r"pr-eval-[a-z0-9]+(-[a-z0-9]+)*", args.name) or args.name.startswith("pr-eval-host"):
            raise SystemExit("--name is pr-eval-<something>, in lower-case letters, digits and dashes")
        SANDBOX, VOLUME = args.name, f"{args.name}-data"
        LABELS["app"] = args.name
    WORKSPACE = workspace()
    if args.delete:
        delete(args.volume)
        return 0
    keys = secrets()
    step(f"Sandbox and previews on Baseten (trials in Blaxel workspace {WORKSPACE})")
    sandbox, origin, meter, created = host(renew=args.renew)
    print(origin, meter)
    if args.renew and not created:
        return 0
    step("Fetching Baseten's brand face for signed-in visitors")
    subprocess.run(["node", str(ROOT / "hosted" / "fonts.mjs")], check=False)  # best effort: without it, Geist
    step("Uploading the app as a new release")
    release = new_release(sandbox, release_files())
    print(release)
    step("Copying the quick sample's tasks")
    task = copy_quick_tasks(sandbox)
    if args.seed:
        step(f"Copying {len(args.seed)} run summaries")
        upload(sandbox, seed_files(args.seed, keys), APP)
    previous = live_release(sandbox)
    step("Smoke test on the new release, before anyone gets it")
    try:
        try_release(sandbox, release, keys, origin, task)
    except SmokeFailed as exc:
        print(f"\nSMOKE TEST FAILED, not released: {exc}\nThe page stays on {previous or 'nothing (a new sandbox)'}.",
              file=sys.stderr)
        return 1
    step("Starting the page and the sign-in server on the new release")
    try:
        switch(sandbox, release)
        start(sandbox, origin, meter, keys, release)
        verify(origin, meter)
        step("Smoke test on the live page")
        smoke(sandbox, release, keys, origin, meter, task, "after")
    except (SmokeFailed, SystemExit, baseten.SandboxError) as exc:
        print(f"\nFAILED once live: {getattr(exc, 'code', None) or exc}", file=sys.stderr)
        if not previous:
            return 1
        step(f"Rolling back to {previous}")
        switch(sandbox, previous)
        start(sandbox, origin, meter, keys, previous)
        verify(origin, meter)
        print(f"Rolled back: the page is on {previous} again.", file=sys.stderr)
        return 1
    prune(sandbox)
    print(f"\nOpen {origin}/ and sign in with a @baseten.co or @blaxel.ai Blaxel account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
