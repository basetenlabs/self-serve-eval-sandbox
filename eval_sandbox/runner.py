"""Run Claude Code trials in dedicated Blaxel sandboxes.

A trial is one (task, model, attempt). Setup installs dependencies, then a
creation-time proxy firewall limits egress to the selected model provider.
The agent's patch is saved and its entire sandbox deleted. A second sandbox,
set up the same way while the agent works, then gets the patch and the hidden
tests. The reference patch is used only by separate validation sandboxes and
the host-side judge. On a task still being checked, an attempt's own sandbox is
set up alongside the check, and its agent starts only once the check passes.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from . import causes, meter, runtime
from . import judge as judge_mod
from .config import (BASETEN_URL, PROVIDER_DOMAINS, Model, Panel, credential_env, redact_file, redact_known,
                     sandbox_credential)
from .rundir import charge, now, write_json
from .tasks import TEST_FILE, Task, signatures, snapshot
from .tasks import load as load_task

DEFAULT_IMAGE = runtime.DEFAULT_IMAGE
PROXY_PORT = 18787
# Set when a run is interrupted: attempts cut short then are dropped, not saved as invalid,
# so `--resume` runs them again.
STOPPING = threading.Event()

PROMPT = """You are working in a checkout of the {repo} repository (the current directory).
Make the code change requested below, the way a contributor would for a pull request.
You can read the code, run the existing tests and add tests of your own. Nobody is
available to answer questions, so make reasonable decisions and finish the change.

{instruction}"""

# Claude Code's own settings that belong to the harness, not the model: every model driven
# by Claude Code runs under the same ceilings, whoever hosts it.
HARNESS_ENV = {
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000",
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "IS_SANDBOX": "1",
}

# The hidden tests run in a network of their own, with only loopback: the sandbox's API holds
# port 8080 on every interface, and tests that serve on it (gin's, for one) would fail on the
# base and merged code alike. Offline like the agent was, and as the same unprivileged user:
# the namespace's capabilities only bring loopback up and are gone at exec.
VERIFIER = "own-network"
OWN_NETWORK = """import ctypes, fcntl, os, socket, struct, sys
uid, gid = os.getuid(), os.getgid()
if ctypes.CDLL(None, use_errno=True).unshare(0x10000000 | 0x40000000):  # CLONE_NEWUSER | CLONE_NEWNET
    sys.exit("pr-eval: no network of their own for the tests: " + os.strerror(ctypes.get_errno()))
for name, text in (("uid_map", f"{uid} {uid} 1"), ("setgroups", "deny"), ("gid_map", f"{gid} {gid} 1")):
    with open(f"/proc/self/{name}", "w") as f:
        f.write(text)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack("16sh", fcntl.ioctl(s, 0x8913, struct.pack("16sh", b"lo", 0)))[1]  # SIOCGIFFLAGS
fcntl.ioctl(s, 0x8914, struct.pack("16sh", b"lo", flags | 1))  # SIOCSIFFLAGS, IFF_UP
os.execvp(sys.argv[1], sys.argv[1:])
"""

# Egress is enforced by the Blaxel proxy firewall, not hostname overrides.
DISALLOWED_TOOLS = "WebFetch,WebSearch"

# Caches that running code leaves behind are nobody's change. A repository can keep its
# .gitignore out of the archive the task is cut from, and then every .pyc the agent's test
# runs wrote would be in its diff, burying the change under megabytes of binary.
CACHES = ("__pycache__/", "*.py[co]", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/")

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PROVIDER_ERROR = re.compile(r"API Error|authentication|unauthori[sz]ed|invalid api key|credit balance|"
                            r"rate limit|overloaded|\b(?:401|403|429|5\d\d)\b|ECONNREFUSED|fetch failed", re.I)


def stage(path: Path, name: str, **extra) -> None:
    """What an attempt or a check is doing right now, for the page's live view; result.json
    replaces it when the attempt is done. Never fails the work it describes."""
    try:
        write_json(path, {"stage": name, "at": now(), **extra})
    except OSError:
        pass


DEFAULT_CONCURRENCY = 8  # attempts, checks or grades at once, unless a run asks for another number


@dataclass
class Settings:
    image: str = DEFAULT_IMAGE
    concurrency: int = DEFAULT_CONCURRENCY
    memory: int = 4096                 # MB; a task that needs more says so (memory_mb)
    region: str = "us-pdx-1"
    workspace: str | None = None
    agent_timeout: int | None = None   # overrides the task's own
    judge: Panel | None = None
    keep_sandboxes: bool = False


def sh(container: str, script: str, *, timeout: int) -> tuple[int, str, bool]:
    """Run through the authenticated Blaxel API as the image's unprivileged user."""
    result = runtime.execute(container, script, timeout=timeout)
    return result.code, result.stdout + result.stderr, result.timed_out


def trial_name(task: Task, model: Model, attempt: int) -> str:
    return f"{task.id}__{model.key}__{attempt}"


def agent_script(model: Model, meter_url: str | None = None) -> tuple[str, dict[str, str]]:
    """The shell that starts Claude Code for this model, and the non-secret env it needs. With
    `meter_url`, its calls go to the provider through the key meter instead (see meter.py)."""
    env = dict(HARNESS_ENV)
    upstream = meter.base_url(meter_url, model.provider) if meter_url else None
    # --include-partial-messages adds raw stream events; run_agent keeps only each
    # message's start and final usage, so a run stopped at the time limit still has its
    # output token counts (see rebuild_usage).
    claude = ('claude -p "$(cat /tmp/instruction.md)" --output-format stream-json --verbose '
              '--include-partial-messages '
              f'--dangerously-skip-permissions --model {shlex.quote(model.model)} '
              f'--effort {shlex.quote(model.effort)} --disallowedTools {DISALLOWED_TOOLS}')
    if model.provider == "baseten":
        # Every model id Claude Code might ask for resolves to the one under test.
        for var in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"):
            env[var] = model.model
        env["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{PROXY_PORT}"
        script = (
            f"python3 /opt/eval/proxy.py --upstream {shlex.quote(upstream or BASETEN_URL)} --effort {shlex.quote(model.effort)} "
            f"--port {PROXY_PORT} --log-file /logs/proxy.log >/dev/null 2>&1 &\n"
            f"for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/{PROXY_PORT}) 2>/dev/null && break; sleep 0.1; done\n"
            'export ANTHROPIC_AUTH_TOKEN="$BASETEN_API_KEY"; unset BASETEN_API_KEY\n'
            f"exec {claude}\n")
    else:
        env["ANTHROPIC_MODEL"] = model.model
        if upstream:
            env["ANTHROPIC_BASE_URL"] = upstream
        script = f"exec {claude}\n"
    return script, env


def run_agent(container: str, model: Model, placeholder_env: dict, log_path: Path, timeout: int,
              meter_url: str | None = None) -> dict:
    """Run Claude Code remotely and collect the durable stream log.

    `placeholder_env` holds the attempt's placeholder credential, never a real key: the
    sandbox's egress proxy adds that, or the attempt's meter ticket (see config.sandbox_credential
    and meter.admit).
    """
    script, env_vars = agent_script(model, meter_url)
    started = time.monotonic()
    result = runtime.execute(container, script, env={**env_vars, **placeholder_env}, timeout=timeout,
                             stdout_path="/logs/agent.jsonl", stderr_path="/logs/agent.stderr")
    log_path.with_suffix(".stderr").write_text(result.stderr)
    runtime.download(container, "/logs/agent.jsonl", log_path)  # streamed: the log can be tens of MB
    for path in (log_path, log_path.with_suffix(".stderr")):
        redact_file(path)
    compact_stream(log_path)
    return {"exit_code": result.code, "timed_out": result.timed_out,
            "seconds": round(time.monotonic() - started, 1), **summarize_stream(log_path)}


def summarize_stream(path: Path) -> dict:
    """Pull the numbers the report needs out of Claude Code's stream-json output."""
    result, tool_calls, assistant_turns, version = None, {}, 0, None
    retries, retry_ms, rate_limited = 0, 0, 0
    for event in events(path):
        if event.get("type") == "system" and event.get("subtype") == "init":
            version = event.get("claude_code_version")
        elif event.get("type") == "system" and event.get("subtype") == "api_retry":
            # Provider backoff is time spent waiting on our rate limit, not on the model.
            retries += 1
            retry_ms += int(event.get("retry_delay_ms") or 0)
            rate_limited += event.get("error_status") == 429
        elif event.get("type") == "assistant":
            assistant_turns += 1
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "tool_use":
                    tool_calls[block.get("name", "?")] = tool_calls.get(block.get("name", "?"), 0) + 1
        elif event.get("type") == "result":
            result = event
    summary = {"tool_calls": tool_calls, "assistant_messages": assistant_turns, "api_retries": retries,
               "rate_limited_retries": rate_limited, "retry_wait_seconds": round(retry_ms / 1000, 1),
               "claude_code_version": version}
    if result:
        summary.update({
            "subtype": result.get("subtype"), "is_error": bool(result.get("is_error")),
            "num_turns": result.get("num_turns"), "duration_ms": result.get("duration_ms"),
            "duration_api_ms": result.get("duration_api_ms"),
            "claude_code_cost_usd": result.get("total_cost_usd"),
            "usage": result.get("usage") or {}, "model_usage": result.get("modelUsage") or {},
            "final_message": (result.get("result") or "")[-2000:],
        })
    return summary


def events(path: Path):
    """Each JSON event of a stream log, read a line at a time: a log can be tens of MB."""
    if not path.is_file():
        return
    with path.open(errors="replace") as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                yield event


# Of the raw stream events --include-partial-messages adds, only these carry usage.
KEPT_STREAM_EVENTS = {"message_start", "message_delta"}


def compact_stream(path: Path) -> None:
    """Drop the per-token stream events, which would make each log several times larger. A line at a time."""
    if not path.is_file():
        return
    tmp, dropped = path.with_suffix(".jsonl.tmp"), False
    with path.open(errors="replace") as lines, tmp.open("w") as kept:
        for line in lines:
            if '"stream_event"' in line:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    event = {}
                if event.get("type") == "stream_event" and (event.get("event") or {}).get("type") not in KEPT_STREAM_EVENTS:
                    dropped = True
                    continue
            kept.write(line if line.endswith("\n") else line + "\n")
    if dropped:
        tmp.replace(path)
    else:
        tmp.unlink()


PROXY_OUTPUT = re.compile(r"\bout=(\d+)")
# The proxy waiting out a provider's 429 before Claude Code sees it (docker/proxy.py).
PROXY_WAIT = re.compile(r"rate-limited: waited ([\d.]+)s over (\d+) retries")


def add_proxy_waits(agent: dict, proxy_log: Path) -> dict:
    """Count the proxy's rate-limit waits with Claude Code's own retries, so the report keeps them out of
    the model's working time."""
    waits = PROXY_WAIT.findall(proxy_log.read_text(errors="replace")) if proxy_log.is_file() else []
    if waits:
        retries = sum(int(n) for _, n in waits)
        agent["api_retries"] = (agent.get("api_retries") or 0) + retries
        agent["rate_limited_retries"] = (agent.get("rate_limited_retries") or 0) + retries
        agent["retry_wait_seconds"] = round((agent.get("retry_wait_seconds") or 0) + sum(float(s) for s, _ in waits), 1)
    return agent


def rebuild_usage(stream: Path, model: Model, proxy_log: Path | None = None) -> tuple[dict, bool]:
    """Token usage of a run Claude Code never finished, because it hit the time limit.

    Claude Code reports usage in its final `result` event, which a stopped run never
    writes. Every assistant message in the stream still carries its input and cache
    counts, and those add up exactly to the final report. Its output count is only
    partial, though: the final one comes from the message's `message_delta` stream event,
    or for a model behind the proxy, from the proxy's per-request log.

    Returns (usage shaped like Claude Code's modelUsage, whether the output counts are
    complete). The request in flight when the run was stopped is never counted.
    """
    messages: dict[str, tuple[str, dict]] = {}   # message id -> (model id, usage), in order
    final_output: dict[str, int] = {}
    streaming: dict[str | None, str] = {}       # parent tool call -> message being streamed
    for event in events(stream):
        if event.get("type") == "assistant":
            message = event.get("message") or {}
            # "<synthetic>" messages are Claude Code's own (an API error shown as a reply)
            if message.get("id") and message.get("model") != "<synthetic>":
                messages[message["id"]] = (message.get("model") or model.model, message.get("usage") or {})
        elif event.get("type") == "stream_event":
            inner, parent = event.get("event") or {}, event.get("parent_tool_use_id")
            if inner.get("type") == "message_start":
                streaming[parent] = (inner.get("message") or {}).get("id")
            elif inner.get("type") == "message_delta" and streaming.get(parent):
                final_output[streaming[parent]] = int((inner.get("usage") or {}).get("output_tokens") or 0)
    usage: dict[str, dict] = {}
    for message_id, (model_id, u) in messages.items():
        counts = usage.setdefault(model_id, {"inputTokens": 0, "cacheReadInputTokens": 0,
                                             "cacheCreationInputTokens": 0, "cacheCreation1hInputTokens": 0,
                                             "outputTokens": 0})
        counts["inputTokens"] += int(u.get("input_tokens") or 0)
        counts["cacheReadInputTokens"] += int(u.get("cache_read_input_tokens") or 0)
        counts["cacheCreationInputTokens"] += int(u.get("cache_creation_input_tokens") or 0)
        counts["cacheCreation1hInputTokens"] += int((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0)
        counts["outputTokens"] += final_output.get(message_id, int(u.get("output_tokens") or 0))
    finished = list(messages)[:-1]  # the last message may have been cut off mid-answer
    complete = bool(messages) and all(m in final_output for m in finished)
    proxied = []
    if proxy_log and proxy_log.is_file():
        with proxy_log.open(errors="replace") as lines:
            proxied = [n for line in lines for n in PROXY_OUTPUT.findall(line)]
    if proxied and len(usage) == 1:
        # The proxy logs each finished request's output, so the count is complete.
        next(iter(usage.values()))["outputTokens"] = sum(int(n) for n in proxied)
        complete = True
    return usage, complete


def price_agent(agent: dict, model: Model, stream: Path, proxy_log: Path | None = None) -> dict:
    """Fill in an agent run's tokens and cost, rebuilding them if the run was stopped."""
    usage = agent.get("model_usage") or {}
    if usage:
        agent["cost_usd"], agent["cost_source"] = agent_cost(model, usage)
    else:
        usage, complete = rebuild_usage(stream, model, proxy_log)
        agent["model_usage"] = usage
        cost = model.price(usage) if usage else None
        agent["cost_usd"] = cost
        agent["cost_source"] = "none" if cost is None else "rebuilt" if complete else "rebuilt-partial"
    agent["tokens"] = token_totals(usage)
    return agent


def token_totals(model_usage: dict) -> dict:
    keys = {"input": "inputTokens", "cached_input": "cacheReadInputTokens",
            "cache_write": "cacheCreationInputTokens", "output": "outputTokens"}
    return {name: sum(int(u.get(k) or 0) for u in model_usage.values()) for name, k in keys.items()}


def agent_cost(model: Model, model_usage: dict) -> tuple[float | None, str]:
    """USD for one agent run, and where the figure came from.

    Claude Code prices every model at Anthropic list rates. That is right for Anthropic
    models, and it knows which cache writes were 1-hour ones (twice the input rate), which
    its modelUsage doesn't break out, so their cost is taken from Claude Code. Anything
    else is priced from configs/models.toml: a list-rate figure for GLM or Kimi is meaningless.
    """
    if not model_usage:
        return None, "none"
    if model.provider == "anthropic" and all(u.get("costBasis") == "list" for u in model_usage.values()):
        return sum(float(u.get("costUSD") or 0) for u in model_usage.values()), "claude-code-list-price"
    return model.price(model_usage), "price-table"


def block_lookups(container: str, domains: list[str] | None = None, routing: list[dict] | None = None) -> None:
    """Narrow the creation-time enforced proxy to the selected provider; `routing` adds its key on the way."""
    runtime.restrict_network(container, domains or ["api.anthropic.com", "inference.baseten.co"], routing or [])


def container_name(run_id: str) -> str:
    # Blaxel refuses a name over 49 characters: "pr-eval-", the slug, "-" and 8 hex digits.
    slug = re.sub(r"[^a-z0-9-]", "-", run_id.lower())[:32].strip("-")
    return f"pr-eval-{slug or 'trial'}-{secrets.token_hex(4)}"


class StepFailed(runtime.RuntimeError):
    """A sandbox or file error, and the step of the attempt it happened at (causes.STEPS)."""

    def __init__(self, step: str, whose: str, error: BaseException):
        super().__init__(str(error))
        self.step, self.whose, self.error = step, whose, error


@contextlib.contextmanager
def at(step: str, whose: str = "the agent's"):
    """Name the step any sandbox or file error inside belongs to; an inner step's name stays."""
    try:
        yield
    except StepFailed:
        raise
    except (runtime.RuntimeError, OSError) as exc:
        raise StepFailed(step, whose, exc) from exc


def start_container(name: str, run_id: str, settings: Settings, memory: int | None = None) -> None:
    """Create a fresh, labelled Blaxel sandbox with a six-hour TTL."""
    if STOPPING.is_set():
        raise runtime.RuntimeError("Run is stopping; no new sandbox is created.")
    runtime.create(name, run_id, settings, memory)
    if STOPPING.is_set():  # the stop's cleanup may have listed sandboxes before this one existed
        raise runtime.RuntimeError("Run is stopping; the caller deletes this sandbox.")


# How a dependency download that the network dropped reads in Go, pip, uv and npm's output.
# Seen under a full run's load: about 1 setup in 30 cut off mid-file, and an instant retry
# cut off again.
DROPPED_DOWNLOAD = re.compile(r"unexpected EOF|connection reset|ECONNRESET|ETIMEDOUT|EAI_AGAIN|i/o timeout|"
                              r"TLS handshake timeout|IncompleteRead|Read timed out|50[234] (Bad Gateway|Service "
                              r"Unavailable|Gateway Time-?out)", re.I)


def sandbox_memory(task: Task, settings: Settings) -> int:
    """MB for this task's sandboxes: the run's size, or more where the repository needs it."""
    return max(settings.memory, int(task.meta["environment"].get("memory_mb", 0)))


def prepare_workspace(container: str, task: Task, log_dir: Path, whose: str = "the agent's") -> tuple[str | None, dict]:
    """Base source in /workspace, dependencies installed, both committed as the baseline.

    Returns (invalid reason or None, setup stats); its log is log_dir/setup.log. A sandbox error
    raises StepFailed, naming the step. The baseline includes whatever setup wrote outside
    .gitignore and CACHES, so the agent's diff is only the agent's.
    """
    commit = "git -c user.name=eval -c user.email=eval@localhost commit -q --no-verify --allow-empty -m"
    with at("upload", whose):
        runtime.upload(container, snapshot(task), "/tmp/source.tar.gz")
        code, out, _ = sh(container, f"tar -xzf /tmp/source.tar.gz -C /workspace && rm /tmp/source.tar.gz && "
                                     f"git init -q -b main && printf '%s\\n' {' '.join(map(shlex.quote, CACHES))} "
                                     f">>.git/info/exclude && git add -A && {commit} base", timeout=300)
    if code != 0:
        (log_dir / "setup.log").write_text(out)
        return "workspace-error", {}
    started = time.monotonic()
    timeout = int(task.meta["environment"].get("setup_timeout_sec", 900))
    logs = []
    with at("setup", whose):
        for wait in (10, 30, None):  # a download can drop mid-file, and installing dependencies again is harmless
            code, out, timed_out = sh(container, task.meta["environment"]["setup"], timeout=timeout)
            logs.append(out)
            if code == 0 or timed_out or wait is None or not DROPPED_DOWNLOAD.search(out):
                break
            time.sleep(wait)
        (log_dir / "setup.log").write_text("\n--- setup again ---\n".join(logs))
        stats = {"exit_code": code, "timed_out": timed_out, "seconds": round(time.monotonic() - started, 1)}
        if code != 0:
            return ("setup-timeout" if timed_out else "setup-error"), stats
        code, out, timed_out = sh(container, f"git add -A && {commit} setup", timeout=120)
        if code or timed_out:
            return "setup-commit-error", stats
        code, out, _ = sh(container, "git rev-parse --verify HEAD", timeout=30)
        if code != 0 or not re.fullmatch(r"[0-9a-f]{40}", out.strip()):
            return "workspace-error", stats
    stats["baseline"] = out.strip()
    with at("network", whose):
        block_lookups(container, ["blocked.invalid"])
    return None, stats


# The most of an agent's patch held in memory, for the judges, who are shown far less of it.
PATCH_IN_MEMORY = 8 << 20


def capture_patch(container: str, baseline: str, local: Path) -> tuple[str, str]:
    """The agent's change as (binary patch, numstat), measured from the setup commit.

    Not from HEAD: some agents commit their work, on a branch of their own, and a diff
    against HEAD would then be empty. The exact bytes go to `local`, since the verifier
    applies that file: decoded command output could carry git warnings or mangled text.
    """
    code, _, timed_out = sh(container, f"git add -A && git diff --cached --binary {baseline} >.git/pr-eval.patch",
                            timeout=120)
    if code or timed_out:
        raise runtime.RuntimeError("Could not capture the agent patch.")
    runtime.download(container, "/workspace/.git/pr-eval.patch", local)
    redact_file(local)
    with local.open("rb") as file:  # the judges read at most a few tens of KB of it
        patch = file.read(PATCH_IN_MEMORY).decode(errors="replace")
    if (size := local.stat().st_size) > PATCH_IN_MEMORY:
        patch += f"\n... [{size - PATCH_IN_MEMORY} more bytes in agent.patch]\n"
    code, numstat, timed_out = sh(container, f"git diff --cached --numstat {baseline}", timeout=60)
    if code or timed_out:
        raise runtime.RuntimeError("Could not capture patch statistics.")
    return patch, numstat


def set_aside_agent_tests(container: str, baseline: str) -> list[str]:
    """Put test files back as they were before the agent; return the ones it had changed.

    The PR's hidden tests decide, so they run against the agent's code alone. The agent's
    own tests could otherwise break them: in Go, a test it adds with the same name as one
    of the PR's stops the package compiling, and a correct fix reads as a failure. The
    judge still sees the agent's whole diff, tests included. Expects the agent's work staged.
    """
    code, out, timed_out = sh(container, f"git diff --cached --name-status --no-renames -z {baseline}", timeout=60)
    if code or timed_out:
        raise runtime.RuntimeError("Could not inspect agent test changes.")
    fields = out.split("\0")
    changed = [(status, path) for status, path in zip(fields[::2], fields[1::2], strict=False) if TEST_FILE.search(path)]
    if changed:
        added = [path for status, path in changed if status.startswith("A")]
        others = [path for status, path in changed if not status.startswith("A")]
        script = []
        if added:
            script.append("rm -f -- " + " ".join(map(shlex.quote, added)))
        if others:
            script.append(f"git checkout -q {baseline} -- " + " ".join(map(shlex.quote, others)))
        code, _, timed_out = sh(container, " && ".join(script), timeout=120)
        if code or timed_out:
            raise runtime.RuntimeError("Could not set aside agent test changes.")
    return [path for _, path in changed]


def run_tests(container: str, task: Task, log_path: Path) -> dict:
    """Copy the hidden tests in and run them. Only ever called after the agent has stopped."""
    runtime.upload(container, task.path / "tests", "/tests")
    started = time.monotonic()
    timeout = int(task.meta["verifier"].get("timeout_sec", 900))
    code, out, timed_out = sh(container, f"python3 -c {shlex.quote(OWN_NETWORK)} bash /tests/test.sh", timeout=timeout)
    log_path.write_text(out)
    if code and "pr-eval: no network of their own" in out:
        raise runtime.RuntimeError("The sandbox can't give the hidden tests a network of their own.")
    return {"exit_code": code, "passed": code == 0 and not timed_out, "timed_out": timed_out,
            "seconds": round(time.monotonic() - started, 1), "summary": test_summary(out), "output": out}


def fresh_folder(trial_dir: Path) -> str | None:
    """Empty an attempt's folder. Returns why its last try was invalid, if it was."""
    # An attempt starts in a clean folder: one cut short or lost to infrastructure leaves files behind.
    earlier = trial_dir / "result.json"
    rerun_after = json.loads(earlier.read_text()).get("invalid_reason") if earlier.is_file() else None
    shutil.rmtree(trial_dir, ignore_errors=True)
    trial_dir.mkdir(parents=True)
    return rerun_after


@dataclass
class Ready:
    """An attempt's own sandbox, created and set up before its agent may start."""
    container: str
    rerun_after: str | None
    started_at: str
    reason: str | None = None          # prepare_workspace's
    setup: dict | None = None
    error: Exception | None = None     # run_trial raises it again, so it is recorded as before


def prepare_trial(task: Task, trial_dir: Path, run_id: str, settings: Settings) -> Ready:
    """Create and set up an attempt's sandbox while its task is still being checked.

    Only the starting code and its dependencies, exactly as run_trial would set it up. The
    caller waits for the check: run_trial gets the sandbox if it passes, discard otherwise.
    Never raises; the sandbox may exist even when `error` is set.
    """
    ready = Ready(container_name(run_id), fresh_folder(trial_dir), now())
    live = trial_dir / "stage.json"
    try:
        memory = sandbox_memory(task, settings)
        stage(live, "sandboxes", started_at=ready.started_at)
        with at("boot"):
            start_container(ready.container, run_id, settings, memory)
        stage(live, "setup", started_at=ready.started_at)
        ready.reason, ready.setup = prepare_workspace(ready.container, task, trial_dir)
    except Exception as exc:  # noqa: BLE001 - an attempt's errors are run_trial's to record
        ready.error = exc
    return ready


def discard(ready: Ready, trial_dir: Path) -> None:
    """Delete an attempt set up for a check that didn't pass, or a run that stopped: no result."""
    try:
        runtime.delete(ready.container)
    except runtime.RuntimeError:
        pass  # nothing to record it in; `pr-eval cleanup` removes the sandbox
    shutil.rmtree(trial_dir, ignore_errors=True)


# The file in an attempt's folder that shows why it wasn't scored, by invalid reason.
LOGS = {"workspace-error": "setup.log", "setup-error": "setup.log", "setup-timeout": "setup.log",
        "setup-commit-error": "setup.log", "agent-crashed": "agent.stderr", "provider-error": "error.log",
        "verifier-apply-error": "verification/apply.log", "verifier-timeout": "verifier.log",
        "task-unstated-name": "verifier.log", "judge-error": "judge.json"}


def run_trial(task: Task, model: Model, attempt: int, trial_dir: Path, run_id: str, settings: Settings,
              ready: Ready | None = None) -> dict:
    """One attempt, in a sandbox `ready` from prepare_trial or one of its own.

    An attempt that isn't scored says why (causes.py): `step`, `cause` and `log`, and `transient`
    when trying it again could go differently.
    """
    rerun_after = ready.rerun_after if ready else fresh_folder(trial_dir)
    container = ready.container if ready else container_name(run_id)
    verifier = container_name(run_id)
    verify_dir = trial_dir / "verification"
    verify_dir.mkdir(exist_ok=True)
    result = {"trial": trial_name(task, model, attempt), "task_id": task.id, "model": model.key,
              "model_id": model.model, "attempt": attempt, "started_at": ready.started_at if ready else now(),
              "outcome": None,
              "invalid_reason": None, **environment_identity(settings),
              "agent_sandbox": container, "verifier_sandbox": verifier}
    if rerun_after:
        result["rerun_after"] = rerun_after
    agent_timeout = settings.agent_timeout or int(task.meta["agent"].get("timeout_sec", 1800))
    memory = sandbox_memory(task, settings)
    alive = [container, verifier]  # reconcile by exact name even if allocation times out
    created = threading.Event()

    def ready_verifier() -> tuple[str | None, dict]:
        # Only the starting code and its dependencies, like the agent's sandbox: the patch
        # and the hidden tests go in after the agent's sandbox is gone.
        try:
            with at("boot", "the verifier's"):
                start_container(verifier, run_id, settings, memory)
        finally:
            created.set()
        return prepare_workspace(verifier, task, verify_dir, "the verifier's")

    def finish(outcome: str, reason: str | None = None, *, step: str | None = None, cause: str | None = None,
               log: str | None = None, transient: bool = False) -> dict:
        result["outcome"], result["invalid_reason"] = outcome, reason
        if outcome == "invalid":
            verifier_side = (reason or "").startswith("verifier-") and reason not in LOGS
            base = (reason or "").removeprefix("verifier-") if verifier_side else reason
            result["step"] = step or causes.REASONS.get(base, ("runner",))[0]
            result["cause"] = cause or causes.sentence(result)
            log = log or (("verification/" if verifier_side else "") + LOGS[base] if base in LOGS else None)
            result["log"] = log if log and (trial_dir / log).is_file() else None
            result["transient"] = transient
        result["finished_at"] = now()
        if STOPPING.is_set():
            result["outcome"] = "interrupted"
        else:
            write_json(trial_dir / "result.json", result)
        return result

    def lost(exc: Exception, step: str, whose: str = "the agent's") -> dict:
        if isinstance(exc, StepFailed):
            step, whose, exc = exc.step, exc.whose, exc.error
        cause = causes.describe(exc, step, whose)
        (trial_dir / "error.log").write_text(f"{cause}\n\n{causes.details(exc)}\n")
        return finish("invalid", "sandbox-error", step=step, cause=cause, log="error.log",
                      transient=causes.transient(exc))

    live = trial_dir / "stage.json"
    helper, verifier_ready = ThreadPoolExecutor(max_workers=1), None
    charged = None  # None until the agent starts
    meter_url, ticket = meter.url(), None
    step = "boot"
    try:
        if meter_url:
            # Hosted: the key stays on the page, and every call from the sandbox, the agent's or the
            # repository's code's, is priced into the run's spend as it happens.
            placeholder_env, routing, ticket = meter.admit(model, trial_dir, next(iter(credential_env(model))), meter_url)
            domains = [urlsplit(meter_url).hostname]
        else:
            placeholder_env, routing = sandbox_credential(model, credential_env(model))
            domains = [PROVIDER_DOMAINS[model.provider]]
        if ready and ready.error:
            raise ready.error
        if not ready:
            stage(live, "sandboxes", started_at=result["started_at"])
        verifier_ready = helper.submit(ready_verifier)
        if ready:
            reason, result["setup"] = ready.reason, ready.setup
        else:
            start_container(container, run_id, settings, memory)
            stage(live, "setup", started_at=result["started_at"])
            reason, result["setup"] = prepare_workspace(container, task, trial_dir)
        if reason:
            return finish("invalid", reason)
        step = "network"
        block_lookups(container, domains, routing)
        step = "upload"
        prompt = PROMPT.format(repo=task.meta["task"]["repo"], instruction=task.instruction.strip())
        (trial_dir / "prompt.md").write_text(prompt)
        runtime.upload(container, trial_dir / "prompt.md", "/tmp/instruction.md")
        step = "agent"
        stage(live, "agent", started_at=result["started_at"])
        # The agent ran, so it spent: charged below, or unpriced in `finally` if this ends first. Through
        # the meter every call is in the ledger already.
        charged = ticket is not None
        agent = run_agent(container, model, placeholder_env, trial_dir / "agent.jsonl", agent_timeout, meter_url)
        if ticket:
            ticket.unlink(missing_ok=True)
        runtime.download(container, "/logs/proxy.log", trial_dir / "proxy.log", optional=True)
        redact_file(trial_dir / "proxy.log")
        result["agent"] = add_proxy_waits(price_agent(agent, model, trial_dir / "agent.jsonl", trial_dir / "proxy.log"),
                                          trial_dir / "proxy.log")
        if not ticket:
            charge(trial_dir, "agent", model.key, result["agent"].get("cost_usd"))
        charged = True
        if "subtype" not in agent and not agent["timed_out"]:
            return finish("invalid", "agent-crashed")
        if agent.get("is_error") and PROVIDER_ERROR.search(agent.get("final_message", "")):
            message = redact_known(agent.get("final_message", ""))
            (trial_dir / "error.log").write_text(message + "\n")
            return finish("invalid", "provider-error", cause=causes.provider(message))
        step = "save"
        patch, numstat = capture_patch(container, result["setup"]["baseline"], trial_dir / "agent.patch")
        result["diff"] = diff_stats(numstat)

        # A finished top-level process is not proof its detached children stopped.
        # Destroy the entire agent VM BEFORE any hidden tests leave this host.
        step = "tests"
        stage(live, "tests", started_at=result["started_at"], diff=result["diff"])
        runtime.delete(container)
        alive.remove(container)
        reason, result["verifier_setup"] = verifier_ready.result()
        if reason:
            return finish("invalid", "verifier-" + reason)
        runtime.upload(verifier, trial_dir / "agent.patch", "/tmp/agent.patch")
        if patch.strip():
            code, out, timed_out = sh(verifier, "git apply --binary --whitespace=nowarn /tmp/agent.patch && git add -A", timeout=120)
            if code or timed_out:
                (verify_dir / "apply.log").write_text(out)
                return finish("invalid", "verifier-apply-error")
        set_aside = set_aside_agent_tests(verifier, result["verifier_setup"]["baseline"])
        tests = run_tests(verifier, task, trial_dir / "verifier.log")
        test_output = tests.pop("output")
        result["tests"] = {**tests, "set_aside": set_aside}
        if tests["timed_out"]:
            return finish("invalid", "verifier-timeout")
        if not tests["passed"] and (name := unstated_name(test_output, task)):
            result["tests"]["unstated_name"] = name
            return finish("invalid", "task-unstated-name")
    except (runtime.RuntimeError, OSError) as exc:
        return lost(exc, step)
    finally:
        if ticket:  # revoked before the sandbox is gone, whatever ended the attempt
            ticket.unlink(missing_ok=True)
        if charged is False:  # the agent started but no cost came back: a sandbox error, or the run was stopped
            charge(trial_dir, "agent", model.key, None)
        # Ending early can leave the verifier mid-setup, which deleting it ends. One still
        # being created can't be deleted yet, so wait for that part.
        if verifier_ready:
            created.wait()
        for name in alive:
            # Debug retention is only for a verifier, never a live agent VM.
            if name == verifier and settings.keep_sandboxes:
                result["retained_sandbox"] = verifier
                continue
            try:
                runtime.delete(name)
            except runtime.RuntimeError as exc:
                result["cleanup_error"] = str(exc)
                (trial_dir / "error.log").write_text(f"{exc}\n")
                finish("invalid", "sandbox-cleanup-error", log="error.log")
        helper.shutdown(wait=False)

    if result.get("cleanup_error"):
        return finish("invalid", "sandbox-cleanup-error", log="error.log")
    if not patch.strip():
        result["judge"] = {"verdict": "fail", "reason": "The agent made no changes.", "skipped": True}
        return finish("failed")
    if settings.judge is None:
        return finish("solved" if tests["passed"] else "failed")
    stage(live, "judge", started_at=result["started_at"], diff=result["diff"], tests_passed=tests["passed"])
    result["judge"], outcome, reason = judge_attempt(settings.judge, task, patch, tests, test_output, trial_dir)
    return finish(outcome, reason)


def judge_attempt(judge: Panel, task: Task, patch: str, tests: dict, test_output: str,
                  trial_dir: Path) -> tuple[dict, str, str | None]:
    """Grade one attempt and save the verdict. Returns (verdict, outcome, invalid reason).

    Solved needs both: the hidden tests passed and the judges' final verdict was pass.
    """
    started = time.monotonic()
    verdict = judge_mod.grade(judge, task, patch, tests, test_output)
    verdict["seconds"] = round(time.monotonic() - started, 1)
    for vote in [*(verdict.get("panel") or []), *([verdict["chair"]] if verdict.get("chair") else [])]:
        if vote.get("cost_usd") is not None or vote.get("input_tokens") is not None:  # it answered, so it was paid
            charge(trial_dir, "judge", vote.get("model") or "", vote.get("cost_usd"))
    write_json(trial_dir / "judge.json", verdict)
    if verdict.get("error"):
        return verdict, "invalid", "judge-error"
    return verdict, ("solved" if tests["passed"] and verdict["verdict"] == "pass" else "failed"), None


def validate_task(task: Task, settings: Settings, run_id: str = "validate") -> dict:
    """Prove a task works in this image before any model is scored on it.

    Inside the trial image, the hidden tests must fail on the base commit and pass with the
    merged change applied. A task that fails here is an environment problem, never a model
    failure, so `run` leaves it out.
    """
    log_dir = task.path / "validation"
    log_dir.mkdir(exist_ok=True)
    container = container_name(run_id)
    record = {"task_id": task.id, **environment_identity(settings), "checked_at": now(), "status": None}
    screened = screen_task(task, settings.judge)
    if screened and screened.get("verdict") == "fail":  # no sandbox needed to know
        record.update(status=UNSTATED, screen=screened)
        write_json(log_dir / "result.json", record)
        return record
    if screened and screened.get("error"):
        print(f"  {task.id}: couldn't check its request against its tests ({screened['error']}); checking its tests anyway")
    earlier = validation_status(task, settings)
    if settings.judge and earlier and earlier != UNSTATED and not earlier.startswith(PASSING_CHECK_FAILURES):
        return json.loads((log_dir / "result.json").read_text())  # checked in this image before; only the screen was new
    live = log_dir / "stage.json"
    step = "boot"
    try:
        stage(live, "sandboxes", run_id=run_id)
        start_container(container, run_id, settings, sandbox_memory(task, settings))
        stage(live, "setup", run_id=run_id)
        reason, record["setup"] = prepare_workspace(container, task, log_dir, "the check's")
        step = "tests"
        if reason:
            record["status"] = reason
            return record
        stage(live, "base", run_id=run_id)
        base = run_tests(container, task, log_dir / "base.log")
        sh(container, "git reset -q --hard && git clean -qfd", timeout=120)
        runtime.upload(container, task.path / "solution" / "reference.patch", "/tmp/reference.patch")
        code, out, _ = sh(container, "git apply --whitespace=nowarn /tmp/reference.patch", timeout=120)
        if code != 0:
            (log_dir / "apply.log").write_text(out)
            record["status"] = "reference-apply-error"
            return record
        stage(live, "reference", run_id=run_id)
        reference = run_tests(container, task, log_dir / "reference.log")
        record["base"] = {k: v for k, v in base.items() if k != "output"}
        record["reference"] = {k: v for k, v in reference.items() if k != "output"}
        if base["timed_out"] or reference["timed_out"]:
            record["status"] = "timeout"
        elif not reference["passed"]:
            record["status"] = "reference-fails"
        elif base["passed"]:
            record["status"] = "non-discriminating"
        else:
            record["status"] = "valid"
        return record
    except (runtime.RuntimeError, OSError) as exc:
        if isinstance(exc, StepFailed):
            step, exc = exc.step, exc.error
        record["status"] = "sandbox-error: " + causes.describe(exc, step, "the check's")
        (log_dir / "error.log").write_text(f"{record['status']}\n\n{causes.details(exc)}\n")
        return record
    finally:
        try:
            runtime.delete(container)
        except runtime.RuntimeError as exc:  # says nothing about the task; `pr-eval cleanup` removes it
            record["cleanup_error"] = str(exc)
        if not STOPPING.is_set():  # a check cut short by a stop proves nothing; run it again next time
            write_json(log_dir / "result.json", record)
        live.unlink(missing_ok=True)


# Check results that say nothing about the task itself; such a task is checked again.
PASSING_CHECK_FAILURES = ("sandbox-error", "setup-timeout", "timeout", "workspace-error")
# The check's status for a task whose tests need what its request never states (judge.screen).
UNSTATED = "request-misses-tests"


def needs_check(task: Task, settings: Settings) -> bool:
    """Not yet checked in this image, its check failed for a passing reason, or a judge
    has yet to compare its request with its tests."""
    status = validation_status(task, settings)
    return ((status or "sandbox-error").startswith(PASSING_CHECK_FAILURES)
            or (settings.judge is not None and status != UNSTATED and not saved_screen(task)))


def saved_screen(task: Task) -> dict | None:
    path = task.path / "screen.json"
    record = json.loads(path.read_text()) if path.is_file() else None
    return record if record and record.get("prompt_version") == judge_mod.SCREEN_VERSION else None


def screen_task(task: Task, panel: Panel | None) -> dict | None:
    """Whether the task's request says enough to pass its tests (judge.screen), asked once of the
    panel's chair, or its one judge, and kept in the task folder. None without a judge."""
    if (record := saved_screen(task)) or panel is None:
        return record
    record = judge_mod.screen(panel.chair or panel.judges[0], task)
    if not record.get("error"):  # an error isn't kept, so the next check asks again
        write_json(task.path / "screen.json", record)
    return record


# A name the tests can't load: Python's import, Go's compiler.
MISSING_NAME = re.compile(r"ImportError: cannot import name '(\w+)'|^\S+\.go:\d+:\d+: undefined: (\w+)", re.M)


def unstated_name(output: str, task: Task) -> str | None:
    """A name the hidden tests couldn't load that the merged change defines and the request never
    gives. Those tests can't even run, whatever the agent wrote: the task is at fault, not the model."""
    missing = {a or b for a, b in MISSING_NAME.findall(output)}
    if not missing:
        return None
    reference = (task.path / "solution" / "reference.patch").read_text(errors="replace")
    defined = set()
    for part in re.split(r"(?m)^(?=diff --git )", reference):
        path = re.match(r"diff --git a/(\S+)", part)
        if path and not TEST_FILE.search(path[1]):
            added = [line[1:] for line in part.splitlines() if line.startswith("+") and not line.startswith("+++")]
            defined |= {name for name, _ in signatures(added)}
    for name in sorted(missing & defined):
        if not re.search(rf"\b{re.escape(name)}\b", task.instruction):
            return name
    return None


def validate_all(tasks: list[Task], settings: Settings, run_id: str, on_result=None) -> None:
    todo = [t for t in tasks if needs_check(t, settings)]
    in_parallel(todo, lambda t: validate_task(t, settings, run_id), settings.concurrency, run_id, on_result)


def validation_status(task: Task, settings: Settings | None = None) -> str | None:
    path = task.path / "validation" / "result.json"
    if not path.is_file():
        return None
    record = json.loads(path.read_text())
    if settings and any(record.get(k) != v for k, v in environment_identity(settings).items()):
        return None
    return record.get("status")


def environment_identity(settings: Settings) -> dict:
    return {"backend": "blaxel", "workspace": runtime.workspace(settings.workspace),
            "image": settings.image, "region": settings.region, "verifier": VERIFIER}


def diff_stats(numstat: str) -> dict:
    files, added, removed = 0, 0, 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            files += 1
            added += int(parts[0]) if parts[0].isdigit() else 0
            removed += int(parts[1]) if parts[1].isdigit() else 0
    return {"files": files, "added": added, "removed": removed}


def test_summary(output: str) -> str:
    """One line: pytest's, vitest's or go test's own verdict."""
    lines = ANSI.sub("", output).strip().splitlines()
    # vitest prints its summary before the failure details, so search the whole log.
    # pytest's line: "=== 2 failed, 9 passed in 1.2s ===", or with -q only "2 failed, 9 passed in 1.2s".
    for pattern in (r"=+ .*(passed|failed|error).* =+|^\d+ (passed|failed|errors?|skipped)\b.* in [\d.]+s|^no tests ran in",
                    r"^\s*Tests\s+\d", r"^(ok|FAIL)\s"):
        hits = [line.strip() for line in lines if re.search(pattern, line)]
        if hits:
            if pattern.startswith("^(ok"):  # go: one line per package; report the first failure
                failed = [h for h in hits if h.startswith("FAIL")]
                return (f"{len(failed)} of {len(hits)} packages failed: {failed[0]}" if failed
                        else f"{len(hits)} packages ok")[:200]
            return hits[-1][:200]
    return (lines[-1].strip() if lines else "")[:200]


# Attempt results that say nothing about the model or its change: a sandbox, setup or provider
# problem, or this runner's own. `--resume` runs those attempts again.
LOST_TO = ("sandbox-error", "sandbox-cleanup-error", "workspace-error", "setup-", "provider-error", "runner-error")


def lost(result: dict) -> bool:
    """An attempt lost to infrastructure, in the agent's sandbox or the verifier's, rather than graded."""
    return result.get("outcome") == "invalid" and \
        (result.get("invalid_reason") or "").removeprefix("verifier-").startswith(LOST_TO)


def lost_trials(job_dir: Path) -> int:
    return sum(lost(json.loads(p.read_text())) for p in (job_dir / "trials").glob("*/result.json"))


def pending_trials(tasks: list[Task], models: list[Model], attempts: int, job_dir: Path) -> list[tuple]:
    """Trials not finished in `job_dir`, or lost to infrastructure, attempt-major, so a stopped run is balanced."""
    pending = []
    for attempt in range(1, attempts + 1):
        for task in tasks:
            for model in models:
                path = job_dir / "trials" / trial_name(task, model, attempt)
                done = path / "result.json"
                if not done.is_file() or lost(json.loads(done.read_text())):
                    pending.append((task, model, attempt, path))
    return pending


def trial_runner(models: list[Model], settings: Settings, run_id: str):
    """Runs one pending trial within its model's own limit, and once more if it was lost to something
    passing (causes.transient). A broken trial is saved, never raised."""
    limits = {m.key: threading.Semaphore(m.max_concurrent or settings.concurrency) for m in models}

    def once(job, ready: Ready | None) -> dict:
        task, model, attempt, path = job
        try:
            return run_trial(task, model, attempt, path, run_id, settings, ready)
        except Exception as exc:  # noqa: BLE001 - one broken trial must not stop the run
            result = {"trial": trial_name(task, model, attempt), "task_id": task.id, "model": model.key,
                      "attempt": attempt, "outcome": "invalid", "invalid_reason": "runner-error", "step": "runner",
                      "cause": "pr-eval itself failed on this attempt.", "log": "error.log", "transient": False,
                      "finished_at": now()}
            if not STOPPING.is_set():
                path.mkdir(parents=True, exist_ok=True)
                (path / "error.log").write_text(causes.details(exc) + "\n")
                write_json(path / "result.json", result)
            return result

    def trial(job, ready: Ready | None = None) -> dict:
        with limits[job[1].key]:
            result = once(job, ready)
            if result.get("transient") and not STOPPING.is_set():
                first = {k: result.get(k) for k in ("invalid_reason", "step", "cause")}
                print(f"  {result['trial']}: {result['cause']} Trying it once more.", flush=True)
                result = once(job, None)
                result["first_try"] = first
                if result.get("outcome") != "interrupted":
                    write_json(job[3] / "result.json", result)
            return result

    return trial


# A run whose first attempts all fail the same way, at the same step, on more than one task stops there:
# a broken sandbox image, upload or provider fails every attempt alike, and the rest would only repeat it.
SAME_FAILURES = 3


class Halted(Exception):
    """The run stopped early: its attempts all failed the same way. Says how."""


class SameFailure:
    """Watches finished attempts; says why to stop once the first SAME_FAILURES all failed alike."""

    def __init__(self):
        self.failed, self.tasks, self.other = [], set(), False
        self.lock = threading.Lock()

    def __call__(self, result) -> str | None:
        if not isinstance(result, dict) or result.get("outcome") in (None, "interrupted"):
            return None  # a check, an attempt left for its check, or one cut short by a stop
        with self.lock:
            if not lost(result):
                self.other = True
                return None
            self.failed.append(causes.signature(result))
            self.tasks.add(result.get("task_id"))
            if self.other or len(self.failed) < SAME_FAILURES or len(set(self.failed)) > 1 or len(self.tasks) < 2:
                return None
            step, cause = self.failed[0]
            words = causes.STEPS.get(step, step).lower()
            return (f"Stopped early: the first {len(self.failed)} attempts all failed the same way ({words}). "
                    f"{cause} That is not the models' doing, so the run's other attempts were not started. "
                    "Resume the run once it is fixed.")


def free_memory_mb() -> int | None:
    """Memory this process may still use, in MB: its container's limit less what the container uses,
    else what the kernel says is available, else half of what the machine has."""
    try:
        limit = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        if limit != "max":
            used = int(Path("/sys/fs/cgroup/memory.current").read_text())
            return (int(limit) - used) >> 20
    except (OSError, ValueError):
        pass
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) >> 10
    except (OSError, ValueError, IndexError):
        pass
    try:
        return (os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")) >> 21
    except (OSError, ValueError, AttributeError):
        return None


# What this process holds at most for one attempt, in MB, by design: two sandboxes each uploading a
# task's source (the SDK sends three 5 MB parts at a time), each command's output tail (runtime.OUTPUT_LIMIT,
# stdout and stderr), the agent's patch (PATCH_IN_MEMORY) and its log, read a line at a time.
ATTEMPT_MB = 80
# One Claude Code process grading an attempt (judge.ask_claude), measured on the hosted page's sandbox.
JUDGE_PROCESS_MB = 400
# Kept free for this process itself and anything else on the machine that grows meanwhile.
RESERVE_MB = 768


def fit(requested: int, free_mb: int | None = None) -> tuple[int, int, int | None]:
    """How many attempts may run at once, and Claude Code judges grade at once, in this machine's free
    memory: (attempts, judge processes, free MB). Unknown memory changes nothing."""
    free_mb = free_memory_mb() if free_mb is None else free_mb
    if free_mb is None:
        return requested, requested, None
    spare = max(free_mb - RESERVE_MB, 0)
    attempts = max(1, min(requested, spare // ATTEMPT_MB))
    judges = max(1, min(attempts, (spare - attempts * ATTEMPT_MB) // JUDGE_PROCESS_MB))
    return attempts, judges, free_mb


def run(tasks: list[Task], models: list[Model], attempts: int, job_dir: Path, settings: Settings,
        run_id: str, on_result=None) -> None:
    """Run every trial not already finished in `job_dir`, a few at a time. Raises Halted if they all fail alike."""
    pending = pending_trials(tasks, models, attempts, job_dir)
    in_parallel(pending, trial_runner(models, settings, run_id), settings.concurrency, run_id, on_result,
                halt=SameFailure())


class Verdict:
    """A task's check status, which the attempts set up alongside the check wait for."""

    def __init__(self):
        self.status, self.known = None, threading.Event()

    def set(self, status: str | None) -> None:
        self.status = status
        self.known.set()

    def wait(self) -> str | None:
        """The status once the check is done, or None if the run stops first."""
        while not self.known.wait(1):
            if STOPPING.is_set():
                return None
        return None if STOPPING.is_set() else self.status


def check_and_run(candidates: list[Task], models: list[Model], attempts: int, job_dir: Path, settings: Settings,
                  run_id: str, on_checked=None, on_result=None) -> None:
    """Check the tasks and run the models on each one as soon as its own check passes.

    Checks and trials share the run's sandboxes, checks first, so a slow check holds up
    only its own task. An attempt on a task still being checked sets its sandbox up
    alongside the check, then waits: its agent starts the moment the check passes, and
    a check that doesn't pass deletes it and leaves no result. `on_checked(task, status,
    unchecked)` follows every task, those checked before first; `on_result(result, done,
    total)` every trial, where total counts the trials of tasks that have passed so far.
    """
    todo = [t for t in candidates if needs_check(t, settings)]
    trial = trial_runner(models, settings, run_id)
    verdicts = {t.id: Verdict() for t in todo}
    unchecked, trials_done, trials_total = len(candidates), 0, 0

    def checked(task: Task, status: str) -> list:
        nonlocal unchecked, trials_total
        unchecked -= 1
        if on_checked:
            on_checked(task, status, unchecked)
        if status != "valid":
            return []
        trials = pending_trials([task], models, attempts, job_dir)
        trials_total += len(trials)
        return trials

    jobs = [("check", t) for t in todo]
    for task in candidates:
        if task not in todo:
            jobs += [("trial", t) for t in checked(task, validation_status(task, settings))]
    jobs += [("early", t) for t in pending_trials(todo, models, attempts, job_dir)]

    def check(task: Task) -> dict:
        status = None
        try:
            record = validate_task(task, settings, run_id)
            status = record["status"]
            return record
        finally:  # here, not in `then`, so the attempts waiting on it never outlive the run
            verdicts[task.id].set(status)

    def early(job) -> dict | None:
        task, path, verdict = job[0], job[3], verdicts[job[0].id]
        ready = None if verdict.known.is_set() else prepare_trial(task, path, run_id, settings)
        if verdict.wait() == "valid":
            return trial(job, ready)
        if ready:
            discard(ready, path)
        return None

    def work(job) -> dict | None:
        kind, item = job
        return check(item) if kind == "check" else early(item) if kind == "early" else trial(item)

    def then(job, result: dict | None) -> list:
        nonlocal trials_done
        kind, item = job
        if kind == "check":
            checked(item, result["status"])  # its attempts are already queued, as early ones
            return []
        if result is None:  # an early attempt on a task that didn't pass its check
            return []
        trials_done += 1
        if on_result:
            on_result(result, trials_done, trials_total)
        return []

    def order(job) -> int:
        kind, item = job
        if kind == "check":
            return 0
        # An attempt still waiting on its check takes only a worker nothing that can run now wants.
        return item[2] + (attempts if kind == "early" and not verdicts[item[0].id].known.is_set() else 0)

    # Checks first, then trials attempt by attempt, so a stopped run is left balanced.
    in_parallel(jobs, work, settings.concurrency, run_id, then=then, order=order, halt=SameFailure())


def in_parallel(jobs: list, work, workers: int, run_id: str, on_result=None, *, then=None, order=None,
                halt=None) -> None:
    """`work` on each job, `workers` at a time; `on_result(result, done, total)` as each lands.

    `then(job, result)` may return more jobs to do. They wait behind the others, unless
    `order` (a sort key) puts them sooner. Once `halt(result)` gives a reason, nothing more
    starts: the work in flight finishes, then Halted says that reason. Ctrl-C, or Stop on the
    page, drops what hasn't finished and removes the run's sandboxes, so the work in flight
    fails fast instead of being waited for.
    """
    waiting, running, done, total, halted = list(jobs), {}, 0, len(jobs), None
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        while (waiting and not halted) or running:
            if order:
                waiting.sort(key=order)
            while waiting and len(running) < workers and not halted:
                job = waiting.pop(0)
                running[pool.submit(work, job)] = job
            finished, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in finished:
                job, result = running.pop(future), future.result()
                done += 1
                more = then(job, result) if then else []
                waiting += more
                total += len(more)
                if on_result:
                    on_result(result, done, total)
                if halt and not halted and (halted := halt(result)):
                    print(halted, flush=True)
        if halted:
            raise Halted(halted)
    except KeyboardInterrupt:
        STOPPING.set()
        pool.shutdown(wait=False, cancel_futures=True)
        cleanup(run_id)
        raise
    finally:
        pool.shutdown(wait=True)


def cleanup(run_id: str | None = None, workspace: str | None = None) -> list[str]:
    """Delete only labelled eval sandboxes in the explicitly selected workspace."""
    return runtime.cleanup(run_id, workspace)


def rejudge(job_dir: Path, tasks_dir: Path, judge: Panel, *, concurrency: int = DEFAULT_CONCURRENCY,
            force: bool = False) -> list[dict]:
    """Grade finished attempts again with these judges, without re-running any agent.

    Skips attempts already graded by the same judges and prompt version unless
    `force`. Attempts that never reached the judge (setup, provider or verifier errors,
    empty diffs) are left as they are.
    """
    def one(trial_dir: Path) -> dict | None:
        path = trial_dir / "result.json"
        result = json.loads(path.read_text())
        patch_path = trial_dir / "agent.patch"
        if not result.get("tests") or not patch_path.is_file() or not patch_path.read_bytes().strip():
            return None
        if result["outcome"] == "invalid" and result.get("invalid_reason") != "judge-error":
            return None
        old = result.get("judge") or {}
        if not force and old.get("model") == judge.name and old.get("prompt_version") == judge_mod.PROMPT_VERSION:
            return None
        before = result["outcome"]
        verdict, result["outcome"], result["invalid_reason"] = judge_attempt(
            judge, load_task(tasks_dir / result["task_id"]), patch_path.read_text(errors="replace"), result["tests"],
            (trial_dir / "verifier.log").read_text(errors="replace"), trial_dir)
        result["judge"] = verdict
        write_json(path, result)
        return {"trial": result["trial"], "before": before, "after": result["outcome"],
                "reason": verdict.get("reason") or verdict.get("error")}

    dirs = [d for d in sorted((job_dir / "trials").iterdir()) if (d / "result.json").is_file()]
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        changed = [r for r in pool.map(one, dirs) if r]
    meta_path = job_dir / "run.json"
    meta = json.loads(meta_path.read_text())
    meta["judge"] = {**judge.as_dict(), "prompt_version": judge_mod.PROMPT_VERSION}
    write_json(meta_path, meta)
    return changed
