"""Run tasks through Claude Code in Docker, one container per trial.

A trial is one (task, model, attempt). Its container lives for the whole trial:

1. the repository at the PR's base commit is copied in and committed as the baseline,
2. the setup command installs dependencies,
3. Claude Code works on the instruction (for Baseten models, through the translating
   proxy started inside the same container),
4. the agent's diff is saved, then the hidden tests are copied in and run,
5. the container is removed and the judge compares the diff with the merged one.

The hidden tests and the merged diff never enter the container before the agent stops.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import judge as judge_mod
from .config import BASETEN_URL, Judge, Model, credential_env
from .tasks import Task
from .tasks import load as load_task

DEFAULT_IMAGE = "eval-sandbox-runner:dev"
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

# The merged PR is one search away, and an agent will look (GLM-5.3 fetched
# github.com/<repo>/pull/<n>/files in the first smoke run). After setup, before the agent
# starts, these resolve to nowhere; Claude Code's web tools are switched off as well.
# Hostname-level only: it stops the obvious lookups, not a determined agent with raw IPs.
BLOCKED_HOSTS = (
    "github.com www.github.com api.github.com raw.githubusercontent.com codeload.github.com "
    "objects.githubusercontent.com gist.github.com gist.githubusercontent.com "
    "patch-diff.githubusercontent.com github.githubassets.com gitlab.com bitbucket.org "
    "sourcegraph.com grep.app pypi.org files.pythonhosted.org registry.npmjs.org "
    "registry.yarnpkg.com proxy.golang.org sum.golang.org pkg.go.dev goproxy.io "
    "deps.dev libraries.io unpkg.com cdn.jsdelivr.net"
).split()
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
    concurrency: int = 4
    cpus: str = "2"
    memory: str = "4g"
    agent_timeout: int | None = None   # overrides the task's own
    judge: Judge | None = None
    keep_containers: bool = False


def docker(*args: str, timeout: int = 120, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, timeout=timeout, check=check)


def exec_argv(container: str, script: str, env_names=(), user: str = "agent") -> list[str]:
    """`docker exec` for a bash script in the trial's /workspace."""
    argv = ["docker", "exec", "-u", user, "-w", "/workspace"]
    for name in env_names:
        argv += ["-e", name]  # by name only: the value comes from our environment, so secrets never appear in argv
    return [*argv, container, "bash", "-c", script]


def sh(container: str, script: str, *, timeout: int, user="agent") -> tuple[int, str, bool]:
    """Run a bash script in the trial container. Returns (exit code, output, timed out)."""
    try:
        p = subprocess.run(exec_argv(container, script, user=user), capture_output=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).decode(errors="replace"), False
    except subprocess.TimeoutExpired as exc:
        out = ((exc.stdout or b"") + (exc.stderr or b"")).decode(errors="replace")
        return -1, out, True


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
    """Run Claude Code headless, streaming its JSON events to `log_path`."""
    script, env_vars = agent_script(model)
    env = {**os.environ, **env_vars, **secrets_env}
    argv = exec_argv(container, script, env_names=[*env_vars, *secrets_env])
    started = time.monotonic()
    timed_out = False
    with open(log_path, "wb") as out, open(log_path.with_suffix(".stderr"), "wb") as err:
        process = subprocess.Popen(argv, stdout=out, stderr=err, env=env)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            docker("exec", container, "pkill", "-f", "claude", check=False)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    compact_stream(log_path)
    return {"exit_code": process.returncode, "timed_out": timed_out,
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


def block_lookups(container: str) -> None:
    hosts = "\n".join(f"0.0.0.0 {h}\n:: {h}" for h in BLOCKED_HOSTS)
    sh(container, f"printf '%s\\n' {shlex.quote(hosts)} >> /etc/hosts", timeout=30, user="root")


def container_name(run_id: str) -> str:
    return f"pr-eval-{run_id}-{secrets.token_hex(4)}"


def start_container(name: str, run_id: str, settings: Settings) -> None:
    """A trial container, labelled with its run so `pr-eval cleanup` can find it."""
    docker("run", "-d", "--name", name, "--label", f"{LABEL}={run_id}",
           "--cpus", settings.cpus, "--memory", settings.memory, "--pids-limit", "4096",
           "--cap-drop", "ALL", "--security-opt", "no-new-privileges", settings.image, "sleep", "infinity")


def prepare_workspace(container: str, task: Task, log_dir: Path) -> tuple[str | None, dict]:
    """Base source in /workspace, dependencies installed, both committed as the baseline.

    Returns (invalid reason or None, setup stats). The baseline includes whatever setup
    wrote outside .gitignore, so the agent's diff is only the agent's.
    """
    docker("cp", str(task.path / "environment" / "source.tar"), f"{container}:/tmp/source.tar")
    commit = "git -c user.name=eval -c user.email=eval@localhost commit -q --no-verify --allow-empty -m"
    code, out, _ = sh(container, f"tar -xf /tmp/source.tar -C /workspace && git init -q -b main && "
                                 f"git add -A && {commit} base", timeout=300)
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
    sh(container, f"git add -A && {commit} setup", timeout=120)
    code, out, _ = sh(container, "git rev-parse --verify HEAD", timeout=30)
    if code != 0 or not re.fullmatch(r"[0-9a-f]{40}", out.strip()):
        return "workspace-error", stats
    stats["baseline"] = out.strip()
    block_lookups(container)
    return None, stats


def capture_patch(container: str, baseline: str) -> tuple[str, str]:
    """The agent's change as (binary patch, numstat), measured from the setup commit.

    Not from HEAD: some agents commit their work, on a branch of their own, and a diff
    against HEAD would then be empty.
    """
    _, patch, _ = sh(container, f"git add -A && git diff --cached --binary {baseline}", timeout=120)
    _, numstat, _ = sh(container, f"git diff --cached --numstat {baseline}", timeout=60)
    return patch, numstat


def run_tests(container: str, task: Task, log_path: Path) -> dict:
    """Copy the hidden tests in and run them. Only ever called after the agent has stopped."""
    docker("cp", str(task.path / "tests"), f"{container}:/tests")
    started = time.monotonic()
    timeout = int(task.meta["verifier"].get("timeout_sec", 900))
    code, out, timed_out = sh(container, "bash /tests/test.sh", timeout=timeout)
    log_path.write_text(out)
    return {"exit_code": code, "passed": code == 0 and not timed_out, "timed_out": timed_out,
            "seconds": round(time.monotonic() - started, 1), "summary": test_summary(out), "output": out}


def run_trial(task: Task, model: Model, attempt: int, trial_dir: Path, run_id: str, settings: Settings) -> dict:
    trial_dir.mkdir(parents=True, exist_ok=True)
    container = container_name(run_id)
    result = {"trial": trial_name(task, model, attempt), "task_id": task.id, "model": model.key,
              "model_id": model.model, "attempt": attempt, "started_at": now(), "outcome": None,
              "invalid_reason": None}
    agent_timeout = settings.agent_timeout or int(task.meta["agent"].get("timeout_sec", 1800))

    def finish(outcome: str, reason: str | None = None) -> dict:
        result["outcome"], result["invalid_reason"] = outcome, reason
        result["finished_at"] = now()
        if STOPPING.is_set():
            result["outcome"] = "interrupted"
            return result
        write_json(trial_dir / "result.json", result)
        return result

    try:
        secrets_env = credential_env(model)
        start_container(container, run_id, settings)
        reason, result["setup"] = prepare_workspace(container, task, trial_dir)
        if reason:
            return finish("invalid", reason)

        prompt = PROMPT.format(repo=task.meta["task"]["repo"], instruction=task.instruction.strip())
        (trial_dir / "prompt.md").write_text(prompt)
        docker("cp", str(trial_dir / "prompt.md"), f"{container}:/tmp/instruction.md")
        agent = run_agent(container, model, secrets_env, trial_dir / "agent.jsonl", agent_timeout)
        docker("cp", f"{container}:/logs/proxy.log", str(trial_dir / "proxy.log"), check=False)
        result["agent"] = price_agent(agent, model, trial_dir / "agent.jsonl", trial_dir / "proxy.log")

        if "subtype" not in agent and not agent["timed_out"]:
            return finish("invalid", "agent-crashed")
        if agent.get("is_error") and PROVIDER_ERROR.search(agent.get("final_message", "")):
            return finish("invalid", "provider-error")  # the provider gave up on the model, not the reverse

        patch, numstat = capture_patch(container, result["setup"]["baseline"])
        (trial_dir / "agent.patch").write_text(patch)
        result["diff"] = diff_stats(numstat)

        tests = run_tests(container, task, trial_dir / "verifier.log")
        test_output = tests.pop("output")
        result["tests"] = tests
        if tests["timed_out"]:
            return finish("invalid", "verifier-timeout")
    except subprocess.TimeoutExpired as exc:
        return finish("invalid", f"docker-timeout: {' '.join(map(str, exc.cmd[:3]))}")
    except subprocess.CalledProcessError as exc:
        (trial_dir / "error.log").write_text((exc.stderr or b"").decode(errors="replace"))
        return finish("invalid", "docker-error")
    finally:
        if not settings.keep_containers:
            docker("rm", "-f", container, check=False, timeout=120)

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
    record = {"task_id": task.id, "image": settings.image, "checked_at": now(), "status": None}
    try:
        start_container(container, run_id, settings)
        reason, record["setup"] = prepare_workspace(container, task, log_dir)
        if reason:
            record["status"] = reason
            return record
        base = run_tests(container, task, log_dir / "base.log")
        sh(container, "git reset -q --hard && git clean -qfd", timeout=120)
        docker("cp", str(task.path / "solution" / "reference.patch"), f"{container}:/tmp/reference.patch")
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
    except (subprocess.SubprocessError, OSError) as exc:
        record["status"] = f"docker-error: {exc}"
        return record
    finally:
        docker("rm", "-f", container, check=False, timeout=120)
        if not STOPPING.is_set():  # a check cut short by a stop proves nothing; run it again next time
            write_json(log_dir / "result.json", record)


def validate_all(tasks: list[Task], settings: Settings, run_id: str, on_result=None) -> None:
    """Check tasks not yet checked in this image, a few at a time."""
    todo = [t for t in tasks if validation_status(t) is None]
    in_parallel(todo, lambda t: validate_task(t, settings, run_id), settings.concurrency, run_id, on_result)


def validation_status(task: Task) -> str | None:
    path = task.path / "validation" / "result.json"
    return json.loads(path.read_text()).get("status") if path.is_file() else None


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


def run(tasks: list[Task], models: list[Model], attempts: int, job_dir: Path, settings: Settings,
        run_id: str, on_result=None) -> None:
    """Run every trial not already finished in `job_dir`, a few at a time."""
    pending = []
    for attempt in range(1, attempts + 1):        # attempt-major, so a stopped run is balanced
        for task in tasks:
            for model in models:
                path = job_dir / "trials" / trial_name(task, model, attempt)
                if not (path / "result.json").is_file():
                    pending.append((task, model, attempt, path))
    limits = {m.key: threading.Semaphore(m.max_concurrent or settings.concurrency) for m in models}

    def trial(job) -> dict:
        task, model, attempt, path = job
        try:
            with limits[model.key]:
                return run_trial(task, model, attempt, path, run_id, settings)
        except Exception as exc:  # noqa: BLE001 - one broken trial must not stop the run
            return {"trial": trial_name(task, model, attempt), "outcome": "invalid",
                    "invalid_reason": f"runner-error: {exc}"}

    in_parallel(pending, trial, settings.concurrency, run_id, on_result)


def in_parallel(jobs: list, work, workers: int, run_id: str, on_result=None) -> None:
    """`work` on each job, `workers` at a time; `on_result(result, done, total)` as each lands.

    Ctrl-C, or Stop on the page, drops what hasn't finished and removes the run's
    containers, so the work in flight fails fast instead of being waited for.
    """
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(work, job) for job in jobs]
        for done, future in enumerate(as_completed(futures), 1):
            if on_result:
                on_result(future.result(), done, len(jobs))
    except KeyboardInterrupt:
        STOPPING.set()
        pool.shutdown(wait=False, cancel_futures=True)
        cleanup(run_id)
        raise
    finally:
        pool.shutdown(wait=True)


def cleanup(run_id: str | None = None) -> list[str]:
    """Remove trial containers a killed run left behind."""
    label = f"{LABEL}={run_id}" if run_id else LABEL
    ids = docker("ps", "-aq", "--filter", f"label={label}").stdout.decode().split()
    if ids:
        docker("rm", "-f", *ids, check=False)
    return ids


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
        if not result.get("tests") or not patch_path.is_file() or not patch_path.read_text().strip():
            return None
        if result["outcome"] == "invalid" and result.get("invalid_reason") != "judge-error":
            return None
        old = result.get("judge") or {}
        if not force and old.get("model") == judge.model and old.get("prompt_version") == judge_mod.PROMPT_VERSION:
            return None
        before = result["outcome"]
        verdict, result["outcome"], result["invalid_reason"] = judge_attempt(
            judge, load_task(tasks_dir / result["task_id"]), patch_path.read_text(), result["tests"],
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
