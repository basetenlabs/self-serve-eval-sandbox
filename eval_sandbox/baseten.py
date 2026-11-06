"""Baseten Sandboxes over plain HTTPS, with the standard library only.

    Management API  https://api.baseten.co/v1/sandboxes/...  sandboxes, images, volumes, previews
    Runtime API     each sandbox's own URL                    files and processes

Both take a sandbox access token minted from a Baseten API key with POST /v1/token (2 hours). Only a
personal key or a team creator service account key can mint one; a model-only key gets 403.
Docs: https://docs.baseten.co/sandboxes/overview
"""
from __future__ import annotations

import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

API = "https://api.baseten.co"


class SandboxError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Client:
    def __init__(self, api_key: str, team_id: str | None = None, api: str = API):
        if not api_key:
            raise SandboxError("A Baseten API key that can mint sandbox tokens is required.")
        self.key, self.team, self.api = api_key, team_id, api.rstrip("/")
        self._token, self._expires = "", 0.0

    # --- HTTP -----------------------------------------------------------------------------------------
    def _send(self, url: str, method: str = "GET", *, body=None, data: bytes | None = None,
              headers: dict | None = None, auth: str | None = None, allow: tuple = (), timeout: int = 120):
        head = dict(headers or {})
        if auth:
            head["Authorization"] = f"Bearer {auth}"
        if self.team:
            head["X-Team-Id"] = self.team
        if body is not None:
            data, head["Content-Type"] = json.dumps(body).encode(), "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=head)
        # A new sandbox's URL can refuse connections for a few seconds after it reports DEPLOYED.
        for attempt in range(15):
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    raw = response.read()
                    return json.loads(raw) if raw and "json" in (response.headers.get("content-type") or "") else raw
            except urllib.error.HTTPError as exc:
                if exc.code in allow:
                    return {"status": exc.code}
                text = exc.read().decode(errors="replace")[:600]
                if exc.code in (502, 503, 504) and attempt < 14:
                    time.sleep(2)
                    continue
                raise SandboxError(f"{method} {urllib.parse.urlsplit(url).path} failed ({exc.code}): {text}", exc.code) from None
            except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
                if attempt == 14:
                    raise SandboxError(f"{method} {urllib.parse.urlsplit(url).path} failed: {exc}") from None
                time.sleep(2)

    def token(self) -> str:
        if self._token and time.time() < self._expires - 600:
            return self._token
        minted = self._send(f"{self.api}/v1/token", "POST", body={"scopes": ["sandboxes"]}, auth=self.key)
        self._token = minted["token"]
        try:
            from datetime import datetime
            self._expires = datetime.fromisoformat(minted["expires_at"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError):
            self._expires = time.time() + 3600
        return self._token

    def manage(self, method: str, path: str, body=None, allow: tuple = ()):
        return self._send(self.api + path, method, body=body, auth=self.token(), allow=allow)

    def runtime(self, box: dict, method: str, path: str, **kwargs):
        return self._send(box["url"].rstrip("/") + path, method, auth=self.token(), **kwargs)

    # --- Sandboxes ------------------------------------------------------------------------------------
    def get(self, name: str) -> dict | None:
        box = self.manage("GET", f"/v1/sandboxes/instances/{urllib.parse.quote(name)}", allow=(404,))
        return None if box.get("status") == 404 else box

    def create(self, body: dict, timeout: int = 300) -> dict:
        """Creates (or, with create_if_not_exists, reuses) a sandbox and waits until it is DEPLOYED."""
        box = self.manage("POST", "/v1/sandboxes/instances", body)
        return self.wait(box, timeout)

    def wait(self, box: dict, timeout: int = 300) -> dict:
        deadline = time.time() + timeout
        while box.get("status") != "DEPLOYED" or not box.get("url"):
            if box.get("status") in ("FAILED", "TERMINATED"):
                raise SandboxError(f"Sandbox {box.get('name')} is {box.get('status')}")
            if time.time() > deadline:
                raise SandboxError(f"Sandbox {box.get('name')} is still {box.get('status')} after {timeout}s")
            time.sleep(2)
            box = self.get(box["name"]) or {"name": box["name"], "status": "PENDING"}
        return box

    def update(self, name: str, body: dict) -> dict:
        return self.manage("PATCH", f"/v1/sandboxes/instances/{urllib.parse.quote(name)}", body)

    def delete(self, name: str) -> None:
        self.manage("DELETE", f"/v1/sandboxes/instances/{urllib.parse.quote(name)}", allow=(404,))

    def list(self, labels: dict | None = None) -> list[dict]:
        out, cursor = [], None
        while True:
            query = {"limit": "100", **({"cursor": cursor} if cursor else {})}
            page = self.manage("GET", f"/v1/sandboxes/instances?{urllib.parse.urlencode(query)}")
            out += [box for box in page.get("items") or []
                    if all((box.get("labels") or {}).get(k) == v for k, v in (labels or {}).items())]
            more = page.get("pagination") or {}
            if not more.get("has_more") or not more.get("cursor"):
                return out
            cursor = more["cursor"]

    def preview(self, sandbox: str, name: str, port: int, public: bool = True) -> str:
        preview = self.manage("POST", f"/v1/sandboxes/instances/{urllib.parse.quote(sandbox)}/previews",
                              {"name": name, "port": port, "public": public, "create_if_not_exists": True})
        return preview["url"].rstrip("/")

    # --- Volumes --------------------------------------------------------------------------------------
    def volume(self, name: str, size: str, region: str, timeout: int = 300) -> dict:
        """The named volume, created when missing; once it is DEPLOYED."""
        path = f"/v1/sandboxes/volumes/{urllib.parse.quote(name)}"
        found = self.manage("GET", path, allow=(404,))
        if found.get("status") == 404:
            found = self.manage("POST", "/v1/sandboxes/volumes", {"name": name, "size": size, "region": region})
        deadline = time.time() + timeout
        while found.get("status") == "DEPLOYING":
            if time.time() > deadline:
                raise SandboxError(f"Volume {name} is still DEPLOYING after {timeout}s")
            time.sleep(2)
            found = self.manage("GET", path)
        return found

    # --- Images ---------------------------------------------------------------------------------------
    def image_status(self, name: str) -> str | None:
        found = self.manage("GET", f"/v1/sandboxes/images/{urllib.parse.quote(name)}", allow=(404,))
        return None if found.get("status") == 404 else found.get("status")

    def build_image(self, name: str, files: dict[str, bytes], memory: int = 4096, timeout: int = 1800) -> str:
        """Pushes a Dockerfile build context and waits for BUILT; returns the reference sandboxes use."""
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
            for path, content in files.items():
                zipped.writestr(path, content)
        pushed = self.manage("POST", "/v1/sandboxes/images", {"name": name, "memory": memory})
        if not pushed.get("upload_url"):
            raise SandboxError(f"The image push returned no upload URL: {json.dumps(pushed)[:300]}")
        self._send(pushed["upload_url"], "PUT", data=archive.getvalue(),
                   headers={"Content-Type": "application/zip", **(pushed.get("upload_headers") or {})}, timeout=600)
        deadline = time.time() + timeout
        while (status := self.image_status(name)) != "BUILT":
            if status == "FAILED":
                logs = self._send(f"{self.api}/v1/sandboxes/images/{urllib.parse.quote(name)}/logs", auth=self.token())
                text = logs.decode(errors="replace") if isinstance(logs, bytes) else json.dumps(logs)
                raise SandboxError(f"Image {name} failed to build:\n{text[-3000:]}")
            if time.time() > deadline:
                raise SandboxError(f"Image {name} is still {status} after {timeout}s")
            time.sleep(5)
        return f"sandbox/{name}:latest"

    # --- Runtime: processes and files -----------------------------------------------------------------
    def exec(self, box: dict, command: str, *, env: dict | None = None, cwd: str | None = None,
             timeout: int = 300) -> tuple[int, str, str]:
        """Runs a command to completion (polled, never held open); returns (exit code, stdout, stderr)."""
        name = f"run-{uuid.uuid4().hex[:12]}"
        body = {"name": name, "command": command, "waitForCompletion": False, "timeout": timeout}
        if env:
            body["env"] = env
        if cwd:
            body["workingDir"] = cwd
        self.runtime(box, "POST", "/process", body=body)
        deadline = time.time() + timeout + 60
        while True:
            proc = self.runtime(box, "GET", f"/process/{name}")
            if proc.get("status") not in ("running", "starting"):
                code = proc.get("exitCode")
                code = code if proc.get("status") == "completed" and code is not None else (code or 1)
                return code, proc.get("stdout") or "", proc.get("stderr") or ""
            if time.time() > deadline:
                self.runtime(box, "DELETE", f"/process/{name}/kill", allow=(404,))
                return 124, proc.get("stdout") or "", f"timed out after {timeout}s"
            time.sleep(1)

    def start(self, box: dict, name: str, command: str, *, env: dict | None = None, cwd: str | None = None,
              restarts: int = 25) -> None:
        """Starts a long-lived named process (timeout 0: it runs until stopped)."""
        body = {"name": name, "command": command, "waitForCompletion": False, "timeout": 0,
                "restartOnFailure": True, "maxRestarts": restarts}
        if env:
            body["env"] = env
        if cwd:
            body["workingDir"] = cwd
        self.runtime(box, "POST", "/process", body=body)

    def processes(self, box: dict) -> list[dict]:
        return self.runtime(box, "GET", "/process") or []

    def kill(self, box: dict, name: str) -> None:
        self.runtime(box, "DELETE", f"/process/{urllib.parse.quote(name)}/kill", allow=(404, 409))

    def write(self, box: dict, path: str, content: bytes, mode: str = "0644") -> None:
        """Writes a binary file at an absolute path (multipart upload)."""
        boundary = uuid.uuid4().hex
        data = b"".join([
            f'--{boundary}\r\nContent-Disposition: form-data; name="permissions"\r\n\r\n{mode}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode(), content, f"\r\n--{boundary}--\r\n".encode()])
        self.runtime(box, "PUT", "/filesystem/" + urllib.parse.quote(path, safe=""), data=data,
                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=600)

    def read(self, box: dict, path: str) -> bytes | None:
        """A file's bytes by absolute path, or None if it doesn't exist."""
        out = self.runtime(box, "GET", "/filesystem/" + urllib.parse.quote(path, safe="") + "?download=true",
                           headers={"Accept": "application/octet-stream"}, allow=(404,), timeout=600)
        if isinstance(out, dict):
            return None if out.get("status") == 404 else json.dumps(out).encode()
        return out
