"""The key meter: every model call an attempt's sandbox makes, priced and added to its run's spend.

Hosted, a trial's sandbox reaches no model provider directly. It may reach only this meter, and
Blaxel's egress proxy, outside the sandbox, puts the attempt's meter ticket on each request to it.
The meter checks the ticket, puts the real key on the request, forwards it to the provider, and
writes what the answer's usage costs to the run's spend.jsonl, which the page's spending limits add
up. So a call made by code from the repository under test counts like one made by the agent.

A ticket is `<run id>.<secret>`; the run's process writes `meter/<sha256 of the secret>.json` in the
run's folder when the agent starts and deletes it when the agent stops. A call with no ticket, a
revoked one, one for a run with no owner or one the page stopped for spending is refused, and so is
a call the meter could not price: a model without a price, or an endpoint whose usage it can't read.

    PR_EVAL_METER_PORT   `pr-eval serve` also runs the meter on this port (hosted/deploy.py sets it)
    PR_EVAL_METER_URL    its public URL; with it set, every attempt goes through the meter
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from . import runner
from .config import BASETEN_URL, KEY_HEADERS, Model, claude_credential

HEADER = "X-Pr-Eval-Meter"
TICKETS = "meter"  # in a run's folder: one file per live ticket
UPSTREAMS = {"anthropic": "https://api.anthropic.com", "baseten": BASETEN_URL.removesuffix("/v1")}
# What each provider's calls may do, and how the meter reads their usage. Free calls are forwarded
# without a charge; anything else is refused, so nothing reaches a provider unpriced.
PRICED = {"anthropic": {"/v1/messages": "anthropic"},
          "baseten": {"/v1/messages": "anthropic", "/v1/chat/completions": "chat", "/v1/completions": "chat"}}
FREE = {"anthropic": {"/v1/messages/count_tokens"}, "baseten": set()}
FREE_GET = re.compile(r"/v1/models(/[^/]+)*")
OVER_LIMIT = "over_limit.txt"  # the page writes it when it stops a run for spending (app.OVER_LIMIT)
ACCESS = "access.json"         # the run's owner (app.ACCESS)
UPSTREAM_TIMEOUT = 900
# Request headers never forwarded: the sandbox's placeholder credential, the ticket, and hop-by-hop ones.
DROP = {"authorization", "x-api-key", HEADER.lower(), "host", "content-length", "connection", "keep-alive",
        "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
        "accept-encoding", "x-forwarded-email"}
KEEP_BACK = re.compile(r"content-type|request-id|x-request-id|retry-after|anthropic-.*|x-ratelimit-.*", re.I)


def url() -> str | None:
    """The meter's public URL, when attempts go through it."""
    return (os.environ.get("PR_EVAL_METER_URL") or "").rstrip("/") or None


# ---------- the run's side: a ticket for each attempt ----------

def admit(model: Model, trial_dir: Path, credential: str, meter_url: str) -> tuple[dict, list[dict], Path]:
    """A ticket for one attempt: the placeholder env its agent gets, the network rule that puts the
    ticket on each request to the meter, and the file that makes it valid (delete it to revoke)."""
    run_dir = trial_dir.parent.parent
    if trial_dir.parent.name != "trials":
        raise runner.runtime.RuntimeError("An attempt outside a run's folder has no run to meter.")
    secret = secrets.token_hex(24)
    tickets = run_dir / TICKETS
    tickets.mkdir(exist_ok=True)
    path = tickets / f"{hashlib.sha256(secret.encode()).hexdigest()}.json"
    runner.write_json(path, {"trial": trial_dir.name, "provider": model.provider, "model": model.key,
                             "prices": model.prices})
    rule = {"destinations": [urlsplit(meter_url).hostname], "headers": {HEADER: "{{SECRET:meter-ticket}}"},
            "secrets": {"meter-ticket": f"{run_dir.name}.{secret}"}}
    return {credential: "pr-eval-placeholder-" + secrets.token_hex(16)}, [rule], path


def base_url(meter_url: str, provider: str) -> str:
    """Where an agent of `provider` sends its calls: the provider's path on the meter."""
    return f"{meter_url}/{provider}" + ("/v1" if provider == "baseten" else "")


# ---------- the meter's side ----------

class Refused(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def ticket(jobs_dir: Path, value: str | None) -> tuple[Path, dict]:
    """The run folder and attempt a ticket belongs to, or Refused."""
    run_id, _, secret = (value or "").rpartition(".")
    if not run_id or not secret or not valid_run_id(run_id):
        raise Refused(401, "No valid meter ticket: model calls go through an attempt's own network rule.")
    run_dir = jobs_dir / run_id
    entry = read_json(run_dir / TICKETS / f"{hashlib.sha256(secret.encode()).hexdigest()}.json")
    if not entry.get("trial"):
        raise Refused(401, "This meter ticket is not valid (the attempt has ended, or it never was).")
    if not read_json(run_dir / ACCESS).get("owner"):
        raise Refused(403, "This run has no owner to count its spending against.")
    if (run_dir / OVER_LIMIT).is_file():
        raise Refused(402, "This run was stopped for spending: " + (run_dir / OVER_LIMIT).read_text()[:300])
    return run_dir, entry


def valid_run_id(run_id: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", run_id)) and ".." not in run_id


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def real_key(provider: str) -> tuple[str, str]:
    """(header, value) carrying the page's own key for `provider`."""
    found = claude_credential() if provider == "anthropic" else (
        {"BASETEN_API_KEY": os.environ["BASETEN_API_KEY"]} if os.environ.get("BASETEN_API_KEY") else {})
    if not found:
        raise Refused(503, f"The meter has no {provider} key.")
    (name, value), = found.items()
    header, form = KEY_HEADERS[name]
    return header, form.format(value)


def usage_counts(shape: str, usage: dict) -> dict:
    """A provider's usage object as Model.price reads it (Claude Code's modelUsage counts)."""
    if shape == "anthropic":
        return {"inputTokens": int(usage.get("input_tokens") or 0),
                "cacheReadInputTokens": int(usage.get("cache_read_input_tokens") or 0),
                "cacheCreationInputTokens": int(usage.get("cache_creation_input_tokens") or 0),
                "cacheCreation1hInputTokens": int((usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0),
                "outputTokens": int(usage.get("output_tokens") or 0)}
    prompt = int(usage.get("prompt_tokens") or 0)
    cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    return {"inputTokens": max(prompt - cached, 0), "cacheReadInputTokens": cached,
            "outputTokens": int(usage.get("completion_tokens") or 0)}


def worst_case(counts: dict, body: dict, raw: bytes) -> dict:
    """What a call whose final usage never came back counts as: the input it reported, else every byte a
    token, and every token it allowed itself to write. Never less than it could have cost."""
    limit = next((body[k] for k in ("max_tokens", "max_completion_tokens", "max_output_tokens")
                  if isinstance(body.get(k), int) and body[k] > 0), 128_000)
    if not any(counts.get(k) for k in ("inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")):
        counts = {**counts, "inputTokens": len(raw)}
    return {**counts, "outputTokens": max(limit, counts.get("outputTokens") or 0)}


class Usage:
    """Folds usage out of a response as it passes: a JSON body, or an SSE stream line by line."""

    def __init__(self, shape: str):
        self.shape, self.found, self.buffer = shape, {}, b""
        self.final = False  # the answer's last usage arrived: a stream cut short has only the input side

    def feed(self, chunk: bytes) -> None:
        self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            self.line(line.decode(errors="replace").strip())

    def line(self, line: str) -> None:
        if not line.startswith("data:"):
            return
        try:
            event = json.loads(line[5:].strip())
        except ValueError:
            return
        if not isinstance(event, dict):
            return
        if self.shape == "anthropic":
            # message_start carries the input side; message_delta the output count so far (and any update).
            usage = (event.get("message") or {}).get("usage") if event.get("type") == "message_start" else event.get("usage")
            if isinstance(usage, dict):
                self.found = {**self.found, **{k: v for k, v in usage.items() if v is not None}}
                self.final = self.final or event.get("type") == "message_delta"
        elif isinstance(event.get("usage"), dict):
            self.found, self.final = event["usage"], True

    def whole(self, body: bytes) -> None:
        try:
            data = json.loads(body)
        except ValueError:
            return
        if isinstance(data, dict) and isinstance(data.get("usage"), dict):
            self.found, self.final = data["usage"], True


class Handler(http.server.BaseHTTPRequestHandler):
    """One provider call: check the ticket, forward it with the real key, charge what it used."""

    protocol_version = "HTTP/1.1"
    jobs_dir: Path

    def do_GET(self):
        self.handle_call(None)

    def do_POST(self):
        self.handle_call(self.rfile.read(int(self.headers.get("content-length") or 0)))

    def handle_call(self, raw: bytes | None) -> None:
        try:
            run_dir, entry = ticket(self.jobs_dir, self.headers.get(HEADER))
            provider, _, rest = self.path.removeprefix("/").partition("/")
            path = "/" + rest.split("?", 1)[0].rstrip("/")
            if provider != entry.get("provider"):
                raise Refused(403, f"This attempt's model runs on {entry.get('provider')}, not {provider or 'nothing'}.")
            shape = PRICED[provider].get(path) if raw is not None else None
            free = path in FREE[provider] if raw is not None else bool(FREE_GET.fullmatch(path))
            if not (shape or free):
                raise Refused(403, f"The meter can't price {self.command} {path}, so it doesn't forward it.")
            body, rates, model_id = {}, None, None
            if shape:
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                if not isinstance(body, dict) or not isinstance(body.get("model"), str):
                    raise Refused(400, "A model call needs a JSON body that names its model.")
                model_id = body["model"]
                rates = Model(key="", label="", kind="", provider=provider, model=model_id, effort="",
                              prices=entry.get("prices") or {})
                if rates.rate_for(model_id) is None:
                    raise Refused(403, f"The meter has no price for {model_id}, so it doesn't forward the call.")
                if shape == "chat" and body.get("stream"):
                    # The only way a streamed Chat Completions answer reports its tokens.
                    body["stream_options"] = {**(body.get("stream_options") or {}), "include_usage": True}
                    raw = json.dumps(body).encode()
            header, value = real_key(provider)
        except Refused as refused:
            return self.refuse(refused.status, str(refused))
        headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP}
        headers[header] = value
        headers["Accept-Encoding"] = "identity"
        # The provider's own host, and a path the checks above matched: never a host the caller names.
        request = urllib.request.Request(UPSTREAMS[provider] + "/" + rest, data=raw,
                                         headers=headers, method=self.command)
        usage = Usage(shape or "")
        trial_dir = run_dir / "trials" / entry["trial"]
        status = 502
        try:
            try:
                upstream = urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT)
            except urllib.error.HTTPError as error:
                upstream = error
            status = upstream.status
            self.relay(upstream, usage)
        except Exception as exc:  # noqa: BLE001 - the provider or the client went away
            if status == 502 and not self.wfile.closed:
                try:
                    self.refuse(502, f"The provider could not be reached ({type(exc).__name__}).")
                except OSError:
                    pass
        finally:
            if shape and status < 400:
                counts = usage_counts(shape, usage.found)
                if not usage.final:
                    counts = worst_case(counts if usage.found else {}, body, raw or b"")
                runner.charge(trial_dir, "call", model_id, rates.price({model_id: counts}))

    def relay(self, upstream, usage: Usage) -> None:
        """Send the provider's answer on as it arrives, reading its usage on the way."""
        self.send_response(upstream.status)
        for name, value in upstream.headers.items():
            if KEEP_BACK.fullmatch(name):
                self.send_header(name, value)
        streaming = "text/event-stream" in (upstream.headers.get("content-type") or "")
        if not streaming:
            payload = upstream.read()
            usage.whole(payload)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_header("transfer-encoding", "chunked")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        while chunk := upstream.read1(65536):
            usage.feed(chunk)
            self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.flush()
        usage.feed(b"\n")
        self.wfile.write(b"0\r\n\r\n")

    def refuse(self, status: int, message: str) -> None:
        payload = json.dumps({"type": "error", "error": {"type": "pr_eval_meter", "message": message}}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args) -> None:
        pass


def serve(jobs_dir: Path, port: int, host: str = "0.0.0.0") -> http.server.ThreadingHTTPServer:
    """Start the meter in the background; returns its server."""
    handler = type("MeterHandler", (Handler,), {"jobs_dir": jobs_dir})
    server = http.server.ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
