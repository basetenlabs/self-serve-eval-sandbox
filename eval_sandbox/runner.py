"""Run Claude Code trials in dedicated Blaxel sandboxes.

A trial is one (task, model, attempt). Setup installs dependencies, then a
creation-time proxy firewall limits egress to the selected model provider.
The agent's patch is saved and its entire sandbox deleted. A second sandbox,
set up the same way while the agent works, then gets the patch and the hidden
tests. The reference patch is used only by separate validation sandboxes and
the host-side judge.
"""
from __future__ import annotations

import json
import re
import secrets
import shlex
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import judge as judge_mod
from . import runtime
from .config import BASETEN_URL, Judge, Model, credential_env
from .tasks import TEST_FILE, Task, snapshot
from .tasks import load as load_task

DEFAULT_IMAGE = runtime.DEFAULT_IMAGE
PROXY_PORT = 18787
LABEL = "pr-eval"
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

# Egress is enforced by the Blaxel proxy firewall, not hostname overrides.
DISALLOWED_TOOLS = "WebFetch,WebSearch"

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PROVIDER_ERROR = re.compile(r"API Error|authentication|unauthori[sz]ed|invalid api key|credit balance|"
                            r"rate limit|overloaded|\b(?:401|403|429|5\d\d)\b|ECONNREFUSED|fetch failed", re.I)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_json(path: Path, data: dict) -> None:
    """Write through a temporary file, so a run killed mid-write never leaves half a file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


@dataclass
class Settings:
    image: str = DEFAULT_IMAGE
    concurrency: int = 8
    memory: int = 4096                 # MB; a task that needs more says so (memory_mb)
    region: str = "us-pdx-1"
    workspace: str | None = None
    agent_timeout: int | None = None   # overrides the task's own
    judge: Judge | None = None
    keep_sandboxes: bool = False


def sh(container: str, script: str, *, timeout: int) -> tuple[int, str, bool]:
    """Run through the authenticated Blaxel API as the image's unprivileged user."""
    result = runtime.execute(container, script, timeout=timeout)
    return result.code, result.stdout + result.stderr, result.timed_out


def trial_name(task: Task, model: Model, attempt: int) -> str:
    return f"{task.id}__{model.key}__{attempt}"


def agent_script(model: Model) -> tuple[str, dict[str, str]]:
    """The shell that starts Claude Code for this model, and the non-secret env it needs."""
    env = dict(HARNESS_ENV)
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
            f"python3 /opt/eval/proxy.py --upstream {BASETEN_URL} --effort {shlex.quote(model.effort)} "
            f"--port {PROXY_PORT} --log-file /logs/proxy.log >/dev/null 2>&1 &\n"
            f"for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/{PROXY_PORT}) 2>/dev/null && break; sleep 0.1; done\n"
            'export ANTHROPIC_AUTH_TOKEN="$BASETEN_API_KEY"; unset BASETEN_API_KEY\n'
            f"exec {claude}\n")
    else:
        env["ANTHROPIC_MODEL"] = model.model
        script = f"exec {claude}\n"
    return script, env


def run_agent(container: str, model: Model, secrets_env: dict, log_path: Path, timeout: int) -> dict:
    """Run Claude Code remotely and collect the durable stream log."""
    script, env_vars = agent_script(model)
    started = time.monotonic()
    result = runtime.execute(container, script, env={**env_vars, **secrets_env}, timeout=timeout,
                             stdout_path="/logs/agent.jsonl", stderr_path="/logs/agent.stderr")
    log_path.write_text(result.stdout)
    log_path.with_suffix(".stderr").write_text(result.stderr)
    compact_stream(log_path)
    return {"exit_code": result.code, "timed_out": result.timed_out,
            "seconds": round(time.monotonic() - started, 1), **summarize_stream(log_path)}


def summarize_stream(path: Path) -> dict:
    """Pull the numbers the report needs out of Claude Code's stream-json output."""
    result, tool_calls, assistant_turns = None, {}, 0
    retries, retry_ms, rate_limited = 0, 0, 0
    for line in path.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "api_retry":
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
               "rate_limited_retries": rate_limited, "retry_wait_seconds": round(retry_ms / 1000, 1)}
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


# Of the raw stream events --include-partial-messages adds, only these carry usage.
KEPT_STREAM_EVENTS = {"message_start", "message_delta"}


def compact_stream(path: Path) -> None:
    """Drop the per-token stream events, which would make each log several times larger."""
    kept, dropped = [], False
    for line in path.read_text(errors="replace").splitlines():
        if '"stream_event"' in line:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                event = {}
            if event.get("type") == "stream_event" and (event.get("event") or {}).get("type") not in KEPT_STREAM_EVENTS:
                dropped = True
                continue
        kept.append(line)
    if dropped:
        tmp = path.with_suffix(".jsonl.tmp")
        tmp.write_text("\n".join(kept) + "\n")
        tmp.replace(path)


PROXY_OUTPUT = re.compile(r"\bout=(\d+)")


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
    if stream.is_file():
        for line in stream.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
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
    proxied = PROXY_OUTPUT.findall(proxy_log.read_text(errors="replace")) if proxy_log and proxy_log.is_file() else []
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


def block_lookups(container: str, domains: list[str] | None = None) -> None:
    """Narrow the creation-time enforced proxy to the selected provider."""
    runtime.restrict_network(container, domains or ["api.anthropic.com", "inference.baseten.co"])


def container_name(run_id: str) -> str:
    slug = re.sub(r"[^a-z0-9-]", "-", run_id.lower()).strip("-")[:42]
    return f"pr-eval-{slug or 'trial'}-{secrets.token_hex(4)}"


def start_container(name: str, run_id: str, settings: Settings, memory: int | None = None) -> None:
    """Create a fresh, labelled Blaxel sandbox with a six-hour TTL."""
    if STOPPING.is_set():
        raise runtime.RuntimeError("Run is stopping; no new sandbox is created.")
    runtime.create(name, run_id, settings, memory)
    if STOPPING.is_set():  # the stop's cleanup may have listed sandboxes before this one existed
        raise runtime.RuntimeError("Run is stopping; the caller deletes this sandbox.")


def sandbox_memory(task: Task, settings: Settings) -> int:
    """MB for this task's sandboxes: the run's size, or more where the repository needs it."""
    return max(settings.memory, int(task.meta["environment"].get("memory_mb", 0)))


def prepare_workspace(container: str, task: Task, log_dir: Path) -> tuple[str | None, dict]:
    """Base source in /workspace, dependencies installed, both committed as the baseline.

    Returns (invalid reason or None, setup stats). The baseline includes whatever setup
    wrote outside .gitignore, so the agent's diff is only the agent's.
    """
    runtime.upload(container, snapshot(task), "/tmp/source.tar.gz")
    commit = "git -c user.name=eval -c user.email=eval@localhost commit -q --no-verify --allow-empty -m"
    code, out, _ = sh(container, f"tar -xzf /tmp/source.tar.gz -C /workspace && rm /tmp/source.tar.gz && "
                                 f"git init -q -b main && git add -A && {commit} base", timeout=300)
    if code != 0:
        (log_dir / "setup.log").write_text(out)
        return "workspace-error", {}
    started = time.monotonic()
    timeout = int(task.meta["environment"].get("setup_timeout_sec", 900))
    code, out, timed_out = sh(container, task.meta["environment"]["setup"], timeout=timeout)
    (log_dir / "setup.log").write_text(out)
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
    block_lookups(container, ["blocked.invalid"])
    return None, stats


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
    patch = local.read_bytes().decode(errors="replace")
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
    code, out, timed_out = sh(container, "bash /tests/test.sh", timeout=timeout)
    log_path.write_text(out)
    return {"exit_code": code, "passed": code == 0 and not timed_out, "timed_out": timed_out,
            "seconds": round(time.monotonic() - started, 1), "summary": test_summary(out), "output": out}


def run_trial(task: Task, model: Model, attempt: int, trial_dir: Path, run_id: str, settings: Settings) -> dict:
    trial_dir.mkdir(parents=True, exist_ok=True)
    container = container_name(run_id)
    verifier = container_name(run_id)
    verify_dir = trial_dir / "verification"
    verify_dir.mkdir(exist_ok=True)
    result = {"trial": trial_name(task, model, attempt), "task_id": task.id, "model": model.key,
              "model_id": model.model, "attempt": attempt, "started_at": now(), "outcome": None,
              "invalid_reason": None, **environment_identity(settings),
              "agent_sandbox": container, "verifier_sandbox": verifier}
    agent_timeout = settings.agent_timeout or int(task.meta["agent"].get("timeout_sec", 1800))
    memory = sandbox_memory(task, settings)
    alive = [container, verifier]  # reconcile by exact name even if allocation times out
    created = threading.Event()

    def ready_verifier() -> tuple[str | None, dict]:
        # Only the starting code and its dependencies, like the agent's sandbox: the patch
        # and the hidden tests go in after the agent's sandbox is gone.
        try:
            start_container(verifier, run_id, settings, memory)
        finally:
            created.set()
        return prepare_workspace(verifier, task, verify_dir)

    def finish(outcome: str, reason: str | None = None) -> dict:
        result["outcome"], result["invalid_reason"] = outcome, reason
        result["finished_at"] = now()
        if STOPPING.is_set():
            result["outcome"] = "interrupted"
        else:
            write_json(trial_dir / "result.json", result)
        return result

    helper, verifier_ready = ThreadPoolExecutor(max_workers=1), None
    try:
        secrets_env = credential_env(model)
        verifier_ready = helper.submit(ready_verifier)
        start_container(container, run_id, settings, memory)
        reason, result["setup"] = prepare_workspace(container, task, trial_dir)
        if reason:
            return finish("invalid", reason)
        block_lookups(container, ["api.anthropic.com"] if model.provider == "anthropic"
                      else ["inference.baseten.co"])
        prompt = PROMPT.format(repo=task.meta["task"]["repo"], instruction=task.instruction.strip())
        (trial_dir / "prompt.md").write_text(prompt)
        runtime.upload(container, trial_dir / "prompt.md", "/tmp/instruction.md")
        agent = run_agent(container, model, secrets_env, trial_dir / "agent.jsonl", agent_timeout)
        runtime.download(container, "/logs/proxy.log", trial_dir / "proxy.log", optional=True)
        result["agent"] = price_agent(agent, model, trial_dir / "agent.jsonl", trial_dir / "proxy.log")
        if "subtype" not in agent and not agent["timed_out"]:
            return finish("invalid", "agent-crashed")
        if agent.get("is_error") and PROVIDER_ERROR.search(agent.get("final_message", "")):
            return finish("invalid", "provider-error")
        patch, numstat = capture_patch(container, result["setup"]["baseline"], trial_dir / "agent.patch")
        result["diff"] = diff_stats(numstat)

        # A finished top-level process is not proof its detached children stopped.
        # Destroy the entire agent VM BEFORE any hidden tests leave this host.
        runtime.delete(container)
        alive.remove(container)
        reason, result["verifier_setup"] = verifier_ready.result()
        if reason:
            return finish("invalid", "verifier-" + reason)
        runtime.upload(verifier, trial_dir / "agent.patch", "/tmp/agent.patch")
        if patch.strip():
            code, _, timed_out = sh(verifier, "git apply --binary --whitespace=nowarn /tmp/agent.patch && git add -A", timeout=120)
            if code or timed_out:
                return finish("invalid", "verifier-apply-error")
        set_aside = set_aside_agent_tests(verifier, result["verifier_setup"]["baseline"])
        tests = run_tests(verifier, task, trial_dir / "verifier.log")
        test_output = tests.pop("output")
        result["tests"] = {**tests, "set_aside": set_aside}
        if tests["timed_out"]:
            return finish("invalid", "verifier-timeout")
    except (runtime.RuntimeError, OSError) as exc:
        (trial_dir / "error.log").write_text(str(exc))
        return finish("invalid", "sandbox-error")
    finally:
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
                finish("invalid", "sandbox-cleanup-error")
        helper.shutdown(wait=False)

    if result.get("cleanup_error"):
        return finish("invalid", "sandbox-cleanup-error")
    if not patch.strip():
        result["judge"] = {"verdict": "fail", "reason": "The agent made no changes.", "skipped": True}
        return finish("failed")
    if settings.judge is None:
        return finish("solved" if tests["passed"] else "failed")
    result["judge"], outcome, reason = judge_attempt(settings.judge, task, patch, tests, test_output, trial_dir)
    return finish(outcome, reason)


def judge_attempt(judge: Judge, task: Task, patch: str, tests: dict, test_output: str,
                  trial_dir: Path) -> tuple[dict, str, str | None]:
    """Grade one attempt and save the verdict. Returns (verdict, outcome, invalid reason).

    Solved needs both: the hidden tests passed and the judge agreed.
    """
    started = time.monotonic()
    verdict = judge_mod.grade(judge, task, patch, tests, test_output)
    verdict["seconds"] = round(time.monotonic() - started, 1)
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
    try:
        start_container(container, run_id, settings, sandbox_memory(task, settings))
        reason, record["setup"] = prepare_workspace(container, task, log_dir)
        if reason:
            record["status"] = reason
            return record
        base = run_tests(container, task, log_dir / "base.log")
        sh(container, "git reset -q --hard && git clean -qfd", timeout=120)
        runtime.upload(container, task.path / "solution" / "reference.patch", "/tmp/reference.patch")
        code, out, _ = sh(container, "git apply --whitespace=nowarn /tmp/reference.patch", timeout=120)
        if code != 0:
            (log_dir / "apply.log").write_text(out)
            record["status"] = "reference-apply-error"
            return record
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
        record["status"] = f"sandbox-error: {exc}"
        return record
    finally:
        try:
            runtime.delete(container)
        except runtime.RuntimeError as exc:  # says nothing about the task; `pr-eval cleanup` removes it
            record["cleanup_error"] = str(exc)
        if not STOPPING.is_set():  # a check cut short by a stop proves nothing; run it again next time
            write_json(log_dir / "result.json", record)


# Check results that say nothing about the task itself; such a task is checked again.
PASSING_CHECK_FAILURES = ("sandbox-error", "docker-error", "setup-timeout", "timeout", "workspace-error")


def needs_check(task: Task, settings: Settings) -> bool:
    """Not yet checked in this image, or its check failed for a passing reason."""
    return (validation_status(task, settings) or "sandbox-error").startswith(PASSING_CHECK_FAILURES)


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
            "image": settings.image, "region": settings.region}


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
    for pattern in (r"=+ .*(passed|failed|error).* =+", r"^\s*Tests\s+\d", r"^(ok|FAIL)\s"):
        hits = [line.strip() for line in lines if re.search(pattern, line)]
        if hits:
            if pattern.startswith("^(ok"):  # go: one line per package; report the first failure
                failed = [h for h in hits if h.startswith("FAIL")]
                return (f"{len(failed)} of {len(hits)} packages failed: {failed[0]}" if failed
                        else f"{len(hits)} packages ok")[:200]
            return hits[-1][:200]
    return (lines[-1].strip() if lines else "")[:200]


def pending_trials(tasks: list[Task], models: list[Model], attempts: int, job_dir: Path) -> list[tuple]:
    """Trials not already finished in `job_dir`, attempt-major, so a stopped run is balanced."""
    pending = []
    for attempt in range(1, attempts + 1):
        for task in tasks:
            for model in models:
                path = job_dir / "trials" / trial_name(task, model, attempt)
                if not (path / "result.json").is_file():
                    pending.append((task, model, attempt, path))
    return pending


def trial_runner(models: list[Model], settings: Settings, run_id: str):
    """Runs one pending trial within its model's own limit. A broken trial is saved, never raised."""
    limits = {m.key: threading.Semaphore(m.max_concurrent or settings.concurrency) for m in models}

    def trial(job) -> dict:
        task, model, attempt, path = job
        try:
            with limits[model.key]:
                return run_trial(task, model, attempt, path, run_id, settings)
        except Exception as exc:  # noqa: BLE001 - one broken trial must not stop the run
            result = {"trial": trial_name(task, model, attempt), "task_id": task.id, "model": model.key,
                      "attempt": attempt, "outcome": "invalid", "invalid_reason": f"runner-error: {exc}"}
            if not STOPPING.is_set():
                path.mkdir(parents=True, exist_ok=True)
                write_json(path / "result.json", result)
            return result

    return trial


def run(tasks: list[Task], models: list[Model], attempts: int, job_dir: Path, settings: Settings,
        run_id: str, on_result=None) -> None:
    """Run every trial not already finished in `job_dir`, a few at a time."""
    in_parallel(pending_trials(tasks, models, attempts, job_dir), trial_runner(models, settings, run_id),
                settings.concurrency, run_id, on_result)


def check_and_run(candidates: list[Task], models: list[Model], attempts: int, job_dir: Path, settings: Settings,
                  run_id: str, on_checked=None, on_result=None) -> None:
    """Check the tasks and run the models on each one as soon as its own check passes.

    Checks and trials share the run's sandboxes, checks first, so a slow check holds up
    only its own task. `on_checked(task, status, unchecked)` follows every task, those
    checked before first; `on_result(result, done, total)` every trial, where total
    counts the trials of tasks that have passed so far.
    """
    todo = [t for t in candidates if needs_check(t, settings)]
    trial = trial_runner(models, settings, run_id)
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
        return [("trial", t) for t in trials]

    jobs = [("check", t) for t in todo]
    for task in candidates:
        if task not in todo:
            jobs += checked(task, validation_status(task, settings))

    def work(job) -> dict:
        kind, item = job
        return validate_task(item, settings, run_id) if kind == "check" else trial(item)

    def then(job, result: dict) -> list:
        nonlocal trials_done
        kind, item = job
        if kind == "check":
            return checked(item, result["status"])
        trials_done += 1
        if on_result:
            on_result(result, trials_done, trials_total)
        return []

    # Checks first, then trials attempt by attempt, so a stopped run is left balanced.
    in_parallel(jobs, work, settings.concurrency, run_id, then=then,
                order=lambda job: 0 if job[0] == "check" else job[1][2])


def in_parallel(jobs: list, work, workers: int, run_id: str, on_result=None, *, then=None, order=None) -> None:
    """`work` on each job, `workers` at a time; `on_result(result, done, total)` as each lands.

    `then(job, result)` may return more jobs to do. They wait behind the others, unless
    `order` (a sort key) puts them sooner. Ctrl-C, or Stop on the page, drops what hasn't
    finished and removes the run's sandboxes, so the work in flight fails fast instead
    of being waited for.
    """
    waiting, running, done, total = list(jobs), {}, 0, len(jobs)
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        while waiting or running:
            if order:
                waiting.sort(key=order)
            while waiting and len(running) < workers:
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
    except KeyboardInterrupt:
        STOPPING.set()
        pool.shutdown(wait=False, cancel_futures=True)
        cleanup(run_id)
        raise
    finally:
        pool.shutdown(wait=True)


def retest(job_dir: Path, tasks_dir: Path, settings: Settings, *, force: bool = False, on_result=None) -> None:
    """Run the hidden tests again from each attempt's saved diff, with its own tests set aside.

    For runs graded before set_aside_agent_tests existed. No model is called: the diff
    is applied to a fresh copy of the starting code, and the judge's verdict is kept.
    Only attempts whose diff touched a test file can change, so only those are rerun.
    """
    todo = []
    for trial_dir in sorted((job_dir / "trials").iterdir()):
        path, patch = trial_dir / "result.json", trial_dir / "agent.patch"
        if not path.is_file() or not patch.is_file():
            continue
        result = json.loads(path.read_text())
        if result["outcome"] in ("solved", "failed") and result.get("tests") and "set_aside" not in result["tests"] \
                and (force or "retested" not in result) and touches_tests(patch.read_text(errors="replace")):
            todo.append((trial_dir, result))
    todo.sort(key=lambda job: job[1]["outcome"] != "failed")  # failures first: they are the ones likely to change
    run_id = f"retest-{job_dir.name}"
    in_parallel(todo, lambda job: retest_trial(*job, load_task(tasks_dir / job[1]["task_id"]), settings, run_id),
                settings.concurrency, run_id, on_result)


def touches_tests(patch: str) -> bool:
    return any(TEST_FILE.search(path) for path in re.findall(r"^diff --git a/(\S+) b/", patch, re.M))


def retest_trial(trial_dir: Path, result: dict, task: Task, settings: Settings, run_id: str) -> dict:
    log_dir = trial_dir / "retest"
    log_dir.mkdir(exist_ok=True)
    container = container_name(run_id)
    try:
        start_container(container, run_id, settings, sandbox_memory(task, settings))
        reason, setup = prepare_workspace(container, task, log_dir)
        if reason:
            return {"trial": result["trial"], "error": reason}
        runtime.upload(container, trial_dir / "agent.patch", "/tmp/agent.patch")
        code, out, _ = sh(container, "git apply --binary --whitespace=nowarn /tmp/agent.patch && git add -A", timeout=120)
        if code:
            (log_dir / "apply.log").write_text(out)
            return {"trial": result["trial"], "error": "the saved diff doesn't apply"}
        set_aside = set_aside_agent_tests(container, setup["baseline"])
        tests = run_tests(container, task, log_dir / "verifier.log")
    except (runtime.RuntimeError, OSError) as exc:
        return {"trial": result["trial"], "error": f"sandbox-error: {exc}"}
    finally:
        try:
            runtime.delete(container)
        except runtime.RuntimeError:
            pass  # the retest still stands; `pr-eval cleanup` removes the sandbox
    tests.pop("output")
    if tests["timed_out"] or STOPPING.is_set():
        return {"trial": result["trial"], "error": "stopped or timed out; left as it was"}
    before = {"outcome": result["outcome"], "tests": result["tests"]}
    verdict = (result.get("judge") or {}).get("verdict")
    solved = tests["passed"] and verdict in ("pass", None)  # None: a run scored on tests alone
    result.update(outcome="solved" if solved else "failed", tests={**tests, "set_aside": set_aside},
                  retested={"at": now(), "before": before})
    old_log = trial_dir / "verifier.log"
    if old_log.is_file():
        old_log.replace(trial_dir / "verifier.before-retest.log")
    (log_dir / "verifier.log").replace(old_log)
    write_json(trial_dir / "result.json", result)
    return {"trial": result["trial"], "before": before["outcome"], "after": result["outcome"],
            "tests": f"{'passed' if before['tests'].get('passed') else 'failed'} -> "
                     f"{'passed' if tests['passed'] else 'failed'}", "judge": verdict}


def cleanup(run_id: str | None = None, workspace: str | None = None) -> list[str]:
    """Delete only labelled eval sandboxes in the explicitly selected workspace."""
    return runtime.cleanup(run_id, workspace)


def rejudge(job_dir: Path, tasks_dir: Path, judge: Judge, *, concurrency: int = 8, force: bool = False) -> list[dict]:
    """Grade finished attempts again with this judge, without re-running any agent.

    Skips attempts already graded by the same judge model and prompt version unless
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
        if not force and old.get("model") == judge.model and old.get("prompt_version") == judge_mod.PROMPT_VERSION:
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
    meta["judge"] = {"model": judge.model, "base_url": judge.base_url, "prompt_version": judge_mod.PROMPT_VERSION}
    write_json(meta_path, meta)
    return changed
