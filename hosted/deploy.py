"""Deploy the eval page to a Baseten sandbox behind "Sign in with Blaxel".

    .venv/bin/python hosted/deploy.py                  create or update, then check the signed-out answers
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
    Volume   pr-eval-host-data at /data: the app (/data/app with its jobs/, tasks/, data/) and the
             sign-in state (/data/sign-in)
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
from eval_sandbox import baseten, runtime, tasks, trace  # noqa: E402
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
APP = "/data/app"
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
RELEASE = ["eval_sandbox", "configs", "docker", "hosted", "pyproject.toml"]
# A run's summary reaches the hosted page, and each attempt's condensed, redacted trace:
# no raw transcripts or logs.
SEED_FILES = ["run.json", "report.json", "report.html"]
# The sign-in server's package ships inside the release as installed here (`npm ci` in hosted/), so the
# sandbox never needs a GitHub Packages token.
SIGN_IN = ROOT / "hosted" / "node_modules" / "@blaxel" / "sign-in"
AUTH = "/data/sign-in"
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


def copy_quick_tasks(sandbox) -> None:
    """The quick sample's task folders, collected here first where missing (with the local `gh` login). On the
    page they let a signed-in person with no GitHub account run the quick sample: its runs only read them.
    Each holds its repository's source (about 200 MB for a large one), so only folders the page lacks go,
    one at a time."""
    have = set(run(sandbox, f"mkdir -p {APP}/tasks && cd {APP}/tasks && ls -d */task.toml 2>/dev/null | cut -d/ -f1 || true").split())
    for repo, prs in tasks.sample(True).items():
        for folder in tasks.collect(repo, prs=prs):
            if folder.name in have:
                continue
            print(f"  {folder.name}", flush=True)
            upload(sandbox, {str(file.relative_to(tasks.DEFAULT_TASKS.parent)): file.read_bytes()
                             for file in sorted(f for f in folder.rglob("*") if f.is_file())}, APP)


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


def start(sandbox, origin: str, meter: str, keys: dict[str, str]) -> None:
    for process in client().processes(sandbox):
        if (process.get("name") or "").startswith(("pr-eval-page", "pr-eval-sign-in")) and process.get("status") in ("running", "starting"):
            client().kill(sandbox, process["name"])
    stamp = time.strftime("%Y%m%d-%H%M%S")
    page_env = {**keys, "BL_WORKSPACE": WORKSPACE, "PR_EVAL_BLAXEL_WORKSPACE": WORKSPACE, "BL_REGION": REGION,
                "PR_EVAL_PUBLIC_REPOS_ONLY": "1", "PR_EVAL_GITHUB_CLIENT_ID": GITHUB_CLIENT_ID,
                "PR_EVAL_GITHUB_APP": GITHUB_APP, "APP_ORIGIN": origin, **LIMITS, **RETENTION,
                "PR_EVAL_METER_PORT": str(METER_PORT), "PR_EVAL_METER_URL": meter,
                "HOME": "/data/home", "PYTHONUNBUFFERED": "1"}
    sign_in_env = {"PORT": str(PORT), "PR_EVAL_PORT": str(PAGE_PORT), "APP_ORIGIN": origin, "BLAXEL_ENV": "prod",
                   "AUTH_STATE_DIR": AUTH, "BL_SANDBOX_API": "http://localhost:8080", "NODE_ENV": "production"}
    name, service = GITHUB_TOKEN
    if token := keychain(item(name, service)) or os.environ.get(name):
        page_env[name] = token
    print(f'Public repositories without a GitHub sign-in: {"on" if token else "off (no " + service + ")"}')
    if admins := os.environ.get("PR_EVAL_ADMINS"):  # the first admins, used only when there is no access list yet
        sign_in_env["PR_EVAL_ADMINS"] = admins
    if key := mail_key():
        sign_in_env |= {MAIL_KEY[0]: key, "PR_EVAL_MAIL_FROM": MAIL_FROM}
    print(f'"Request access": {"on" if key else "off (no " + MAIL_KEY[1] + ")"}')
    client().start(sandbox, f"pr-eval-page-{stamp}", cwd=APP, env=page_env,
                   command=f"sh -c 'mkdir -p /data/home && exec /opt/venv/bin/python -m eval_sandbox serve --no-open --port {PAGE_PORT} --jobs {APP}/jobs'")
    client().start(sandbox, f"pr-eval-sign-in-{stamp}", cwd=f"{APP}/hosted", env=sign_in_env,
                   command="node --disable-warning=ExperimentalWarning server.mjs")
    run(sandbox, f"for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:{PORT}/login "
                 f"&& curl -s -o /dev/null http://127.0.0.1:{PAGE_PORT}/api/state -H 'host: 127.0.0.1:{PAGE_PORT}' && exit 0; sleep 1; done; "
                 "echo 'the page did not start' >&2; exit 1", timeout=90)


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
    step("Uploading the app")
    files = release_files()
    run(sandbox, f"mkdir -p {APP} {AUTH} && chmod 700 {AUTH} && rm -rf " + " ".join(f"{APP}/{e}" for e in RELEASE))
    upload(sandbox, files, APP)
    step("Copying the quick sample's tasks")
    copy_quick_tasks(sandbox)
    if args.seed:
        step(f"Copying {len(args.seed)} run summaries")
        upload(sandbox, seed_files(args.seed, keys), APP)
    step("Starting the page and the sign-in server")
    start(sandbox, origin, meter, keys)
    verify(origin, meter)
    print(f"\nOpen {origin}/ and sign in with a @baseten.co or @blaxel.ai Blaxel account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
