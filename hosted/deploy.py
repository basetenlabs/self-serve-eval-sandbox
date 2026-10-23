"""Deploy the eval page to a Blaxel sandbox behind "Sign in with Blaxel".

    .venv/bin/python hosted/deploy.py                  create or update, then check the signed-out answers
    .venv/bin/python hosted/deploy.py --seed jobs/x    also copy finished runs' reports and traces to the hosted page
    .venv/bin/python hosted/deploy.py --delete         remove the sandbox (add --volume to drop its data too)

Where it runs (the dedicated trial workspace, so the page can start trials there):

    Sandbox  pr-eval-host, from the image in hosted/Dockerfile (bl push -d hosted, once)
    Preview  public HTTPS; hosted/gateway.mjs signs people in and is the only public door
    Volume   pr-eval-host-data at /data: the app (/data/app with its jobs/, tasks/, data/),
             the sign-in state (/data/auth: OAuth client, session key, sessions)
    Secrets  read on this Mac (Keychain, `gh auth token`) and handed to the page's process
             environment only; never written to the volume, the image or this repository

Keys come from the environment when set, else from the Keychain:
    BASETEN_API_KEY         Keychain baseten-api-key (open models and the Kimi K3 judge)
    CLAUDE_CODE_OAUTH_TOKEN Keychain pr-eval-claude-code-oauth-token (Claude models and the Opus judge)
    OPENAI_API_KEY          Keychain baseten-openai-api-key (the GPT-6.1 Sol judge)
    BL_API_KEY              Keychain pr-eval-host-blaxel-api-key (service account pr-eval-host)
    GH_TOKEN                `gh auth token` (public repositories only: PR_EVAL_PUBLIC_REPOS_ONLY)

People sign in with GitHub through the OAuth App "Baseten Eval Sandbox" (device flow, owned by
SystemSculpt). Its client id is public; it has no secret here. Their tokens stay in the page's memory.
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
GITHUB_CLIENT_ID = os.environ.get("PR_EVAL_GITHUB_CLIENT_ID", "Ov23li1ZAcTSk0isJf5x")
# The release: everything the page and its runs read from the repository.
RELEASE = ["eval_sandbox", "configs", "docker", "hosted", "pyproject.toml"]
# A run's summary reaches the hosted page, and each attempt's condensed, redacted trace:
# no raw transcripts or logs.
SEED_FILES = ["run.json", "report.json", "report.html"]
SECRETS = {
    "BASETEN_API_KEY": "baseten-api-key",
    "CLAUDE_CODE_OAUTH_TOKEN": "pr-eval-claude-code-oauth-token",
    "OPENAI_API_KEY": "baseten-openai-api-key",
    "BL_API_KEY": "pr-eval-host-blaxel-api-key",
}
LEAK = trace.SECRET


def step(message: str) -> None:
    print(f"\n▸ {message}", flush=True)


def keychain(service: str) -> str | None:
    p = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True)
    return p.stdout.strip() or None


def secrets() -> dict[str, str]:
    found = {name: os.environ.get(name) or keychain(service) for name, service in SECRETS.items()}
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


def run(sandbox, command: str, timeout: int = 300, env: dict | None = None) -> str:
    result = sandbox.process.exec({"command": f"set -eu\n{command}", "env": env or {}, "waitForCompletion": True,
                                   "timeout": timeout})
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
    # The gateway owns sign-in, so the preview itself is public.
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


def release_files() -> dict[str, bytes]:
    out = {}
    for entry in RELEASE:
        path = ROOT / entry
        for file in [path] if path.is_file() else sorted(path.rglob("*")):
            if file.is_file() and "__pycache__" not in file.parts and not file.name.startswith("."):
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
        if (process.name or "").startswith(("pr-eval-page", "pr-eval-gateway")) and process.status in ("running", "starting"):
            sandbox.process.kill(process.name)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    page_env = {**keys, "BL_WORKSPACE": WORKSPACE, "PR_EVAL_BLAXEL_WORKSPACE": WORKSPACE, "BL_REGION": REGION,
                "PR_EVAL_PUBLIC_REPOS_ONLY": "1", "PR_EVAL_GITHUB_CLIENT_ID": GITHUB_CLIENT_ID,
                "HOME": "/data/home", "PYTHONUNBUFFERED": "1"}
    # No `timeout`: on Blaxel it can end a long-lived process once it elapses.
    sandbox.process.exec({"name": f"pr-eval-page-{stamp}", "workingDir": APP, "env": page_env,
                          "command": f"mkdir -p /data/home && exec /opt/venv/bin/python -m eval_sandbox serve --no-open --port {PAGE_PORT} --jobs {APP}/jobs",
                          "restartOnFailure": True, "maxRestarts": 25})
    sandbox.process.exec({"name": f"pr-eval-gateway-{stamp}", "workingDir": f"{APP}/hosted",
                          "env": {"PORT": str(PORT), "PR_EVAL_PORT": str(PAGE_PORT), "APP_ORIGIN": origin,
                                  "BLAXEL_ENV": "prod", "AUTH_STATE_DIR": "/data/auth", "BL_SANDBOX_API": "http://localhost:8080",
                                  "NODE_ENV": "production"},
                          "command": "exec node gateway.mjs", "restartOnFailure": True, "maxRestarts": 25})
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
    run(sandbox, f"mkdir -p {APP} /data/auth && chmod 700 /data/auth && rm -rf " + " ".join(f"{APP}/{e}" for e in RELEASE))
    upload(sandbox, release_files(), APP)
    if args.seed:
        step(f"Copying {len(args.seed)} run summaries")
        upload(sandbox, seed_files(args.seed, keys), APP)
    step("Starting the page and the sign-in gateway")
    start(sandbox, origin, keys)
    verify(origin)
    print(f"\nOpen {origin}/ and sign in with a @baseten.co or @blaxel.ai Blaxel account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
