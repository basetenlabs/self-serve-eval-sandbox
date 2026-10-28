"""Deploy the eval page to a Blaxel sandbox behind "Sign in with Blaxel".

    .venv/bin/python hosted/deploy.py                  create or update, then check the signed-out answers
    .venv/bin/python hosted/deploy.py --seed jobs/x    also copy finished runs' reports and traces to the hosted page
    .venv/bin/python hosted/deploy.py --delete         remove the sandbox (add --volume to drop its data too)

Where it runs (the dedicated trial workspace, so the page can start trials there):

    Sandbox  pr-eval-host, from the image in hosted/Dockerfile (bl push -d hosted, once)
    Preview  public HTTPS; hosted/server.mjs (@blaxel/sign-in) signs people in and is the only public door
    Volume   pr-eval-host-data at /data: the app (/data/app with its jobs/, tasks/, data/),
             the sign-in state (/data/sign-in: OAuth client, session key, sessions). /data/auth is the
             earlier gateway's; its OAuth client is imported once, so nobody is asked to consent again.
    Secrets  read on this Mac (Keychain, `gh auth token`) and handed to the page's process
             environment only; never written to the volume, the image or this repository

Keys come from the Keychain, else from the environment:
    BASETEN_API_KEY         Keychain pr-eval-host-baseten-api-key (Baseten workspace key pr-eval-host:
                            open models and the Kimi K3 judge)
    ANTHROPIC_API_KEY       Keychain pr-eval-host-anthropic-api-key (company key self-serve-eval-sandbox:
                            Claude models and the Opus judge)
    OPENAI_API_KEY          Keychain baseten-openai-api-key (the GPT-6.1 Sol judge)
    BL_API_KEY              Keychain pr-eval-host-blaxel-api-key (service account pr-eval-host)
    GH_TOKEN                `gh auth token` (public repositories only: PR_EVAL_PUBLIC_REPOS_ONLY)

People sign in with GitHub through the GitHub App "Baseten Eval Sandbox" (device flow; read-only
Contents, Pull requests and Metadata; owned by SystemSculpt until it moves to basetenlabs). Its client
id is public and the page needs nothing else: its client secret and private key stay in this Mac's
Keychain (pr-eval-github-app-client-secret, pr-eval-github-app-private-key). Their tokens stay in the
page's memory.
"""
from __future__ import annotations

import argparse
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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from eval_sandbox import trace  # noqa: E402
WORKSPACE = "pr-eval-01db4d88"
REGION = "us-pdx-1"
SANDBOX = "pr-eval-host"
VOLUME = "pr-eval-host-data"
VOLUME_MB = 20480
IMAGE = "pr-eval-host"
MEMORY = 8192
PORT = 3000
PAGE_PORT = 8765
PREFIX = "eval"
APP = "/data/app"
LABELS = {"app": "pr-eval-host", "owner": "mstolarz"}
GITHUB_CLIENT_ID = os.environ.get("PR_EVAL_GITHUB_CLIENT_ID", "Iv23liQbVPW7Rbr3qQJC")
GITHUB_APP = os.environ.get("PR_EVAL_GITHUB_APP", "baseten-eval-sandbox")  # its slug: github.com/apps/<slug>
# One workspace and one set of keys serve everyone: runs going at once, in all and per person, and what runs
# started in the last 24 hours may cost in dollars, in all and per person (a quick sample is about $2).
LIMITS = {name: os.environ.get(name, default) for name, default in {
    "PR_EVAL_MAX_RUNS": "2", "PR_EVAL_RUNS_PER_PERSON": "1",
    "PR_EVAL_SPEND_TOTAL": "300", "PR_EVAL_SPEND_PER_PERSON": "50"}.items()}
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
    "OPENAI_API_KEY": "baseten-openai-api-key",
    "BL_API_KEY": "pr-eval-host-blaxel-api-key",
}
LEAK = trace.SECRET


def step(message: str) -> None:
    print(f"\n▸ {message}", flush=True)


def keychain(service: str) -> str | None:
    try:
        p = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True)
    except FileNotFoundError:  # not a Mac
        return None
    return p.stdout.strip() or None


def secrets() -> dict[str, str]:
    # The page's own Keychain items come first, so a personal key exported in the shell never reaches it.
    found = {name: keychain(service) or os.environ.get(name) for name, service in SECRETS.items()}
    found["GH_TOKEN"] = os.environ.get("GH_TOKEN") or subprocess.run(
        ["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
    if missing := [name for name, value in found.items() if not value]:
        raise SystemExit(f"missing {', '.join(missing)}: see the top of hosted/deploy.py")
    return found


def sdk():
    # The deploy itself acts as the person running it (their `bl login`), in the trial workspace.
    os.environ["BL_WORKSPACE"] = WORKSPACE
    os.environ.setdefault("BL_REGION", REGION)
    from blaxel.core import SyncSandboxInstance, SyncVolumeInstance
    return SyncSandboxInstance, SyncVolumeInstance


def run(sandbox, command: str, timeout: int = 300, env: dict | None = None, cwd: str | None = None) -> str:
    result = sandbox.process.exec({"command": f"set -eu\n{command}", "env": env or {}, "waitForCompletion": True,
                                   "timeout": timeout, **({"workingDir": cwd} if cwd else {})})
    if result.exit_code:
        raise SystemExit(f"sandbox command failed ({result.exit_code}): {(result.stderr or result.stdout or '')[-2000:]}")
    return result.stdout or ""


def image() -> str:
    out = subprocess.run(["bl", "--skip-version-warning", "get", "image", f"sandbox/{IMAGE}", "--latest", "-w", WORKSPACE],
                         capture_output=True, text=True)
    refs = re.findall(rf"^sandbox/{IMAGE}:[A-Za-z0-9._-]+$", out.stdout + "\n" + out.stderr, re.M)
    if not refs:
        raise SystemExit(f"no {IMAGE} image yet: bl push -d hosted --name {IMAGE} --type sandbox -w {WORKSPACE}")
    return refs[0]


def host():
    Sandbox, Volume = sdk()
    Volume.create_if_not_exists({"name": VOLUME, "size": VOLUME_MB, "region": REGION, "labels": LABELS})
    try:
        sandbox = Sandbox.get(SANDBOX)
    except Exception:  # noqa: BLE001 - not there yet
        step(f"Creating sandbox {SANDBOX} with volume {VOLUME} at /data")
        sandbox = Sandbox.create({
            "name": SANDBOX, "image": image(), "memory": MEMORY, "region": REGION,
            "ports": [{"target": PORT, "protocol": "HTTP"}],
            "volumes": [{"name": VOLUME, "mount_path": "/data", "read_only": False}],
            "labels": LABELS,
        })
        ready(sandbox)
    # The sign-in server owns sign-in, so the preview itself is public.
    preview = sandbox.previews.create_if_not_exists({"metadata": {"name": "web"},
                                                     "spec": {"port": PORT, "public": True, "prefixUrl": PREFIX}})
    url = preview.spec.url
    return sandbox, url.rstrip("/")


def ready(sandbox) -> None:
    """A new sandbox can refuse commands for a while after it is created (WORKLOAD_UNAVAILABLE)."""
    for wait in (1, 2, 4, 8, 15, 30, 30):
        try:
            sandbox.process.exec({"command": "true", "waitForCompletion": True, "timeout": 30})
            return
        except Exception:  # noqa: BLE001 - the platform says to retry until the workload is up
            time.sleep(wait)
    raise SystemExit(f"sandbox {SANDBOX} didn't start; see: bl logs sandbox {SANDBOX} -w {WORKSPACE}")


def upload(sandbox, files: dict[str, bytes], remote: str) -> None:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(content), 0o644, int(time.time())
            tar.addfile(info, io.BytesIO(content))
    target = f"/tmp/upload-{os.getpid()}-{int(time.time())}.tgz"
    sandbox.fs.write_binary(target, archive.getvalue())
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


def start(sandbox, origin: str, keys: dict[str, str]) -> None:
    for process in sandbox.process.list() or []:
        if (process.name or "").startswith(("pr-eval-page", "pr-eval-gateway", "pr-eval-sign-in")) and process.status in ("running", "starting"):
            sandbox.process.kill(process.name)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    page_env = {**keys, "BL_WORKSPACE": WORKSPACE, "PR_EVAL_BLAXEL_WORKSPACE": WORKSPACE, "BL_REGION": REGION,
                "PR_EVAL_PUBLIC_REPOS_ONLY": "1", "PR_EVAL_GITHUB_CLIENT_ID": GITHUB_CLIENT_ID,
                "PR_EVAL_GITHUB_APP": GITHUB_APP, "APP_ORIGIN": origin, **LIMITS,
                "HOME": "/data/home", "PYTHONUNBUFFERED": "1"}
    sign_in_env = {"PORT": str(PORT), "PR_EVAL_PORT": str(PAGE_PORT), "APP_ORIGIN": origin, "BLAXEL_ENV": "prod",
                   "AUTH_STATE_DIR": AUTH, "BL_SANDBOX_API": "http://localhost:8080", "NODE_ENV": "production"}
    # Once: adopt the earlier gateway's OAuth client for this origin, so nobody is asked to consent again.
    run(sandbox, f"if [ -f /data/auth/oauth-client.json ] && ! ls {AUTH}/oauth-client-*.json >/dev/null 2>&1; then "
                 "node node_modules/@blaxel/sign-in/server.mjs --import-client /data/auth/oauth-client.json --config site.config.mjs; fi",
        env=sign_in_env, cwd=f"{APP}/hosted")
    # No `timeout`: on Blaxel it can end a long-lived process once it elapses.
    sandbox.process.exec({"name": f"pr-eval-page-{stamp}", "workingDir": APP, "env": page_env,
                          "command": f"mkdir -p /data/home && exec /opt/venv/bin/python -m eval_sandbox serve --no-open --port {PAGE_PORT} --jobs {APP}/jobs",
                          "restartOnFailure": True, "maxRestarts": 25})
    sandbox.process.exec({"name": f"pr-eval-sign-in-{stamp}", "workingDir": f"{APP}/hosted", "env": sign_in_env,
                          "command": "exec node --disable-warning=ExperimentalWarning server.mjs",
                          "restartOnFailure": True, "maxRestarts": 25})
    run(sandbox, f"for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:{PORT}/login "
                 f"&& curl -s -o /dev/null http://127.0.0.1:{PAGE_PORT}/api/state -H 'host: 127.0.0.1:{PAGE_PORT}' && exit 0; sleep 1; done; "
                 "echo 'the page did not start' >&2; exit 1", timeout=90)


def verify(origin: str) -> None:
    """The signed-out answers a healthy deploy gives."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect)

    def status(path: str, accept: str = "*/*") -> int:
        try:
            return opener.open(urllib.request.Request(origin + path, headers={"accept": accept}), timeout=30).status
        except urllib.error.HTTPError as exc:
            return exc.code
    got = {"login": status("/login"), "page": status("/", "text/html"), "api": status("/api/state", "application/json")}
    if got != {"login": 200, "page": 303, "api": 401}:
        raise SystemExit(f"unexpected signed-out answers {got}; see: bl logs sandbox {SANDBOX} -w {WORKSPACE}")
    print(f"signed-out answers ok: {got}")


def delete(volume: bool) -> None:
    Sandbox, Volume = sdk()
    Sandbox.delete(SANDBOX)
    for _ in range(60):  # gone before a deploy can create it afresh
        try:
            left = Sandbox.get(SANDBOX)
        except Exception:  # noqa: BLE001 - not found: deleted
            break
        if left.status == "TERMINATED":  # one can stay listed like this until deleted again (2026-10-23)
            Sandbox.delete(SANDBOX)
        time.sleep(3)
    else:
        raise SystemExit(f"sandbox {SANDBOX} is still there; try again in a minute")
    print(f"deleted sandbox {SANDBOX}")
    if volume:
        for _ in range(60):
            try:
                Volume.delete(VOLUME)
                print(f"deleted volume {VOLUME}")
                return
            except Exception:  # noqa: BLE001 - still attached while the sandbox shuts down
                time.sleep(2)
        raise SystemExit(f"could not delete volume {VOLUME}; try again in a minute")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=Path, nargs="*", default=[], help="finished runs to show on the hosted page")
    parser.add_argument("--delete", action="store_true", help="remove the hosted sandbox")
    parser.add_argument("--volume", action="store_true", help="with --delete, also remove its data")
    args = parser.parse_args()
    if args.delete:
        delete(args.volume)
        return 0
    keys = secrets()
    step(f"Sandbox and preview in {WORKSPACE}")
    sandbox, origin = host()
    print(origin)
    step("Uploading the app")
    files = release_files()
    run(sandbox, f"mkdir -p {APP} {AUTH} && chmod 700 {AUTH} && rm -rf " + " ".join(f"{APP}/{e}" for e in RELEASE))
    upload(sandbox, files, APP)
    if args.seed:
        step(f"Copying {len(args.seed)} run summaries")
        upload(sandbox, seed_files(args.seed, keys), APP)
    step("Starting the page and the sign-in server")
    start(sandbox, origin, keys)
    verify(origin)
    print(f"\nOpen {origin}/ and sign in with a @baseten.co or @blaxel.ai Blaxel account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
