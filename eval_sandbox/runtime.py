"""Blaxel transport. Credentials and the workspace binding never enter a sandbox.

The SDK is imported lazily so the offline unit suite needs no SDK or credentials.
An explicitly selected workspace is required: the CLI's current workspace is never
an implicit target. Each process binds to one workspace before importing the SDK.
"""
from __future__ import annotations

import builtins
import hashlib
import io
import json
import os
import re
import secrets
import shlex
import subprocess
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

IMAGE_DIR = Path(__file__).resolve().parents[1] / "docker"
CONFIG_PATH = Path.home() / ".config/pr-eval/blaxel.json"
LABEL = "pr-eval"
IMAGE_FILES = ("Dockerfile", "proxy.py", "blaxel.toml")
DEFAULT_IMAGE = "pr-eval-runner-" + hashlib.sha256(
    b"".join((IMAGE_DIR / f).read_bytes() for f in IMAGE_FILES)
).hexdigest()[:12]
_LOCK = threading.Lock()
_BOUND: str | None = None
_SANDBOXES: dict[str, object] = {}


class RuntimeError(builtins.RuntimeError):
    """Infrastructure failure; never a model failure."""


def workspace(explicit: str | None = None) -> str:
    configured = {}
    if CONFIG_PATH.is_file():
        configured = json.loads(CONFIG_PATH.read_text())
    value = explicit or os.environ.get("PR_EVAL_BLAXEL_WORKSPACE") or configured.get("workspace")
    if not value or value == "main" or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", value):
        raise RuntimeError("Choose a dedicated Blaxel workspace with PR_EVAL_BLAXEL_WORKSPACE; 'main' is not allowed.")
    return value


def sdk(explicit: str | None = None):
    global _BOUND
    selected = workspace(explicit)
    with _LOCK:
        if _BOUND is not None and _BOUND != selected:
            raise RuntimeError("This process is already bound to another workspace; start a new pr-eval process.")
        os.environ["BL_WORKSPACE"] = selected
        os.environ["PR_EVAL_BLAXEL_WORKSPACE"] = selected
        try:
            from blaxel.core import SyncSandboxInstance
            from blaxel.core.common.settings import settings
        except ImportError as exc:
            raise RuntimeError("Install the project dependencies, including the pinned Blaxel SDK.") from exc
        if settings.workspace != selected or settings.base_url != "https://api.blaxel.ai/v0":
            raise RuntimeError("Blaxel must authenticate to the selected workspace on the production API.")
        _BOUND = selected
        return SyncSandboxInstance


def check_connection() -> None:
    sdk()
    # Older workspaces can return an empty status outside the SDK enum.
    from blaxel.core.client import client
    try:
        response = client.get_httpx_client().get(f"/workspaces/{workspace()}", timeout=30)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        raise RuntimeError("Cannot connect to the selected Blaxel workspace; check its CLI login.") from exc
    if data.get("name") != workspace() or data.get("status") not in ("ready", ""):
        raise RuntimeError("The dedicated Blaxel workspace is not ready yet.")


def _bl(args: list[str]) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(["bl", "--skip-version-warning", *args, "-w", workspace()],
                                capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Install/login with the Blaxel CLI to inspect or build trial images.") from exc
    if result.returncode:
        raise RuntimeError("Cannot inspect the Blaxel image. Check workspace login and image availability.")
    return result


def resolve_image(image: str) -> str:
    if ":" in image or "@sha256:" in image:
        return image
    # --latest intentionally prints a reference, even with -o json.
    result = _bl(["get", "image", f"sandbox/{image}", "--latest"])
    references = re.findall(r"^sandbox/[a-z0-9-]+:[A-Za-z0-9._-]+$",
                            result.stdout + "\n" + getattr(result, "stderr", ""), re.M)
    if len(references) != 1:
        raise RuntimeError("The bl CLI returned an invalid image reference.")
    return references[0]


def image_exists(image: str) -> bool:
    if ":" in image:
        result = _bl(["get", "image", image, "-o", "json"])
        return bool(json.loads(result.stdout))
    result = _bl(["get", "images", "--q", image, "--all", "-o", "json"])
    data = json.loads(result.stdout)
    entries = data if isinstance(data, list) else data.get("data", [])
    return any(item.get("metadata", {}).get("name") == image
               and item.get("spec", {}).get("tagCount", 0) > 0 for item in entries)


def build_image(image: str, claude_code_version: str | None = None) -> int:
    check_connection()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", image):
        raise RuntimeError("Use a Blaxel image name, not a Docker registry tag.")
    # Only the image's three source files leave the Mac; not the repository, tasks,
    # .env files, job results or any local credentials.
    with tempfile.TemporaryDirectory(prefix="pr-eval-image-") as d:
        for name in IMAGE_FILES:
            content = (IMAGE_DIR / name).read_text()
            if name == "Dockerfile" and claude_code_version:
                if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", claude_code_version):
                    raise RuntimeError("Claude Code version must be a numeric release.")
                content = re.sub(r"ARG CLAUDE_CODE_VERSION=.*", f"ARG CLAUDE_CODE_VERSION={claude_code_version}", content)
            (Path(d) / name).write_text(content)
        return subprocess.run(["bl", "push", "--name", image, "--type", "sandbox",
                               "-w", workspace(), "--yes"], cwd=d, timeout=3600).returncode


def create(name: str, run_id: str, settings, memory: int | None = None):
    """A sandbox of `memory` MB, or the run's default size."""
    api = sdk(settings.workspace)
    try:
        sandbox = api.create({
            "name": name, "image": settings.image, "memory": memory or settings.memory,
            "region": settings.region, "ttl": "6h",
            "labels": {LABEL: run_id}, "extra_args": {"iptables": "enabled"},
            "network": {"firewall": {"rulesets": ["proxy"]},
                        "allowedDomains": ["*"], "proxy": {"routing": []}},
        })
        _SANDBOXES[name] = sandbox
        check = execute(name, "test \"$(id -u)\" != 0 && python3 -c " + shlex.quote(
            "import socket; s=socket.socket(); s.settimeout(2); "
            "code=s.connect_ex(('127.0.0.1',8080)); s.close(); raise SystemExit(code == 0)"), timeout=15)
        if check.code or check.timed_out:
            raise RuntimeError("Trial image must run non-root and refuse in-sandbox API access.")
        return sandbox
    except Exception as exc:
        # Named creation is not retried: a timeout may still have allocated it.
        # Our own messages say which step failed; anything else is named by type only.
        why = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        raise RuntimeError(f"Blaxel creation failed for {name} ({why}); use cleanup to reconcile.") from exc


def get(name: str):
    if name not in _SANDBOXES:
        _SANDBOXES[name] = sdk().get(name)
    return _SANDBOXES[name]


def restrict_network(name: str, domains: list[str]) -> None:
    if not domains or "*" in domains:
        raise RuntimeError("The agent requires a nonempty provider-only allowlist.")
    from blaxel.core.sandbox.types import SandboxUpdateNetwork
    try:
        sandbox = sdk().update_network(name, SandboxUpdateNetwork(network={
            "firewall": {"rulesets": ["proxy"]},
            "allowedDomains": domains, "proxy": {"routing": []},
        }))
        actual = sandbox.spec.network.to_dict()
        allowed = actual.get("allowedDomains") or actual.get("proxy", {}).get("allowedDomains")
        if allowed != domains or actual.get("firewall", {}).get("rulesets") != ["proxy"]:
            raise RuntimeError("Blaxel did not apply the requested network restriction.")
        _SANDBOXES[name] = sandbox
    except Exception as exc:
        raise RuntimeError("Could not enforce the agent's provider-only network.") from exc
    # The control plane's answer is not proof the proxy enforces it yet: check from inside.
    probe = execute(name, "curl -s -m 5 -o /dev/null -w '%{http_code}' https://github.com", timeout=20)
    if probe.timed_out or probe.stdout.strip() != "000":
        raise RuntimeError("GitHub is still reachable inside the sandbox; no agent was started.")


def twice(transfer):
    """A transfer, and once more if it fails: a dropped upload or download is harmless to repeat,
    and losing the attempt to one is not."""
    try:
        return transfer()
    except Exception:  # noqa: BLE001 - the second try raises whatever is really wrong
        time.sleep(2)
        return transfer()


def upload(name: str, local: Path, remote: str) -> None:
    sandbox = get(name)

    def transfer():
        if local.is_dir():
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w") as tar:
                tar.add(local, arcname=".")
            target = "/tmp/upload-" + secrets.token_hex(8) + ".tar"
            sandbox.fs.write_binary(target, archive.getvalue())
            result = execute(name, f"mkdir -p {shlex.quote(remote)} && tar -xf {target} -C {shlex.quote(remote)} && rm {target}", timeout=120)
            if result.code:
                raise RuntimeError("Could not unpack uploaded files.")
        else:
            sandbox.fs.write_binary(remote, local.read_bytes())

    try:
        twice(transfer)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Could not upload {local.name} ({type(exc).__name__}).") from exc


def download(name: str, remote: str, local: Path, *, optional: bool = False) -> None:
    """An optional file may well not exist, so only a required one is tried twice."""
    def transfer():
        local.write_bytes(get(name).fs.read_binary(remote))

    try:
        transfer() if optional else twice(transfer)
    except Exception:
        if not optional:
            raise RuntimeError(f"Could not download {remote}.")


@dataclass
class Execution:
    code: int
    stdout: str
    stderr: str
    timed_out: bool = False


def execute(name: str, script: str, *, timeout: int, env: dict | None = None,
            stdout_path: str | None = None, stderr_path: str | None = None) -> Execution:
    sandbox = get(name)
    process_name = "eval-" + secrets.token_hex(8)
    out = stdout_path or f"/tmp/{process_name}.out"
    err = stderr_path or f"/tmp/{process_name}.err"
    # Preserve only toolchain and platform proxy/certificate variables. In
    # particular no Blaxel credential or unrelated process environment is inherited.
    keep = ["PATH", "GOPATH", "GOTOOLCHAIN", "UV_PYTHON_INSTALL_DIR", "UV_LINK_MODE",
            "COREPACK_ENABLE_DOWNLOAD_PROMPT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
            "SSL_CERT_FILE", "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"]
    # A missing lowercase proxy must NOT be exported as an empty string: urllib
    # treats it as an instruction to discard the uppercase proxy, bypassing the
    # enforced proxy and stalling on denied direct egress.
    proxies = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
    variables = " ".join(f'{k}="${{{k}:-${{{k.lower()}:-}}}}"' if k in proxies
                         else f'{k}="${{{k}:-}}"' for k in keep)
    forwarded = " ".join(f'{k}="${{{k}}}"' for k in (env or {}))
    if any(not re.fullmatch(r"[A-Z_][A-Z0-9_]*", k) for k in (env or {})):
        raise RuntimeError("Invalid environment variable name.")
    # The platform may create root-owned files in the image home (for example
    # its certificate cache). Give the workload a clean, user-owned home instead.
    # Node's built-in fetch (corepack, for one) ignores HTTPS_PROXY unless told,
    # and the firewall drops direct egress, so pnpm setups would time out.
    command = (f"mkdir -p /logs/home && env -i {variables} {forwarded} HOME=/logs/home "
               f"CI=1 TZ=UTC NODE_USE_ENV_PROXY=1 bash -c {shlex.quote(script)} >{out} 2>{err}")
    try:
        sandbox.process.exec({"name": process_name, "command": command, "working_dir": "/workspace",
                              "env": env or {}, "wait_for_completion": False, "keep_alive": True,
                              "timeout": timeout + 30})
        timed_out = False
        try:
            p = sandbox.process.wait(process_name, max_wait=timeout * 1000, interval=500)
        except TimeoutError:
            timed_out = True
            try:
                sandbox.process.kill(process_name)
            except Exception:
                # The process may exit between the wait deadline and the kill.
                # Accept only a confirmed terminal state, never an unknown failure.
                p = sandbox.process.get(process_name)
                if p.status not in ("completed", "failed", "killed", "stopped"):
                    raise
            p = sandbox.process.wait(process_name, max_wait=30_000, interval=250)
        if p.status not in ("completed", "failed", "killed", "stopped"):
            raise RuntimeError("Blaxel process completion could not be confirmed.")
        stdout = sandbox.fs.read_binary(out).decode(errors="replace")
        stderr = sandbox.fs.read_binary(err).decode(errors="replace")
        return Execution(-1 if timed_out else p.exit_code, stdout, stderr, timed_out)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Blaxel process transport failed ({type(exc).__name__}).") from exc


def delete(name: str) -> None:
    api = sdk()
    try:
        api.delete(name)
        _SANDBOXES.pop(name, None)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                sandbox = api.get(name)
            except Exception as exc:
                if getattr(exc, "status_code", None) == 404:
                    return
                raise
            if str(sandbox.status).upper().split(".")[-1] == "TERMINATED":
                return
            time.sleep(0.25)
        raise RuntimeError(f"Deletion not confirmed for {name}.")
    except RuntimeError:
        raise
    except Exception as exc:
        if getattr(exc, "status_code", None) == 404:
            _SANDBOXES.pop(name, None)
            return
        raise RuntimeError(f"Could not delete {name} ({type(exc).__name__}).") from exc


def cleanup(run_id: str | None = None, selected: str | None = None) -> list[str]:
    api = sdk(selected)
    removed, failed = [], []
    for sandbox in api.list().auto_paging_iter():
        labels = sandbox.metadata.labels.to_dict() if sandbox.metadata.labels else {}
        if LABEL in labels and (run_id is None or labels[LABEL] == run_id):
            # One stuck delete must not leave the rest billing until their TTL.
            try:
                delete(sandbox.metadata.name)
                removed.append(sandbox.metadata.name)
            except RuntimeError:
                failed.append(sandbox.metadata.name)
    if failed:
        raise RuntimeError(f"Could not delete {', '.join(failed)}; run pr-eval cleanup again.")
    return removed


def image_claude_version(image: str, region: str = "us-pdx-1", run_id: str = "image-probe") -> str | None:
    """Best effort, for the report: a failed probe must not fail the run."""
    from types import SimpleNamespace
    name = "pr-eval-probe-" + secrets.token_hex(4)
    try:
        create(name, run_id, SimpleNamespace(workspace=workspace(), image=image, memory=2048, region=region))
        result = execute(name, "claude --version", timeout=60)
        return result.stdout.split()[0] if not result.code and result.stdout.split() else None
    except RuntimeError:
        return None
    finally:
        try:
            delete(name)
        except RuntimeError:
            pass  # labelled with the run, so `pr-eval cleanup` finds it
