"""LLM judges: does the agent's diff do what the merged PR did?

The hidden tests are the first check. The judges are the second: each reads the request,
the merged diff and the agent's diff on its own, and catches what tests miss (a change
that games the tests, edits them, or only half-implements the request). The chair then
reads the same evidence and every judge's verdict, and gives the final pass or fail with
a one-sentence overview. The report shows that next to every attempt, with each judge's
own verdict under it.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import config
from .config import Judge, Panel
from .tasks import Task

MAX_PATCH_CHARS = 60_000

PROMPT_VERSION = 3
SYSTEM = """You review code changes for a benchmark of coding agents. You are given a change
request taken from a real pull request, the change the maintainers merged, and a change
an agent made from the request alone. Decide whether a maintainer would accept the
agent's change as resolving the request, judged by behavior.

Pass when the change does what the request asks and breaks nothing else. A different
approach from the merged change is fine.

Fail only for one of these, and name it in the reason:
- incomplete: part of what the request asks for is missing or wrong;
- gamed: the change special-cases test inputs, hardcodes expected values, or disables
  or rewrites checks so they pass instead of fixing the behavior;
- regression: it breaks behavior the request did not ask to change.

Hidden tests from the merged PR were run against the agent's change; their result is
given. Passing tests are strong evidence for pass. Failing tests are strong evidence
against, unless they fail for a reason unrelated to the request. Do not fail a change for
hypothetical edge cases that neither the request nor the merged tests cover, or for being
less thorough than the merged change in ways a maintainer would still accept. Ignore
style, comments, docs and changelog entries.

Answer with JSON only: {"verdict": "pass" | "fail", "reason": "<one sentence, under 30 words>"}"""

CHAIR = """You chair a panel of judges grading a coding agent's change for a benchmark. You
are given the change request from a real pull request, the change the maintainers merged,
the agent's change, the hidden test result, and each judge's verdict with its reason.

Give the panel's final verdict on the judges' standard: pass when a maintainer would
accept the agent's change as resolving the request, judged by behavior; fail only when it
is incomplete, gamed, or causes a regression. Check each judge's reason against the
evidence rather than counting votes, and side with the reasons the diffs and tests
support. Passing hidden tests are strong evidence for pass, failing ones strong evidence
against.

Answer with JSON only: {"verdict": "pass" | "fail", "reason": "<one sentence, under 40 words: what the panel found, and whose reading you followed if they split>"}"""

# Claude Code, quiet: no update checks, telemetry or error reports from a judge. A judge asks
# once, so a prompt cache is never read and its write (an hour's, at twice the input rate)
# would only double the input's cost.
CLAUDE_ENV = {"DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
              "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_PROMPT_CACHING": "1"}

_slots: dict[tuple, threading.BoundedSemaphore] = {}
_slots_lock = threading.Lock()


def parse(reply: str | None) -> dict:
    """The verdict in a reply: JSON, maybe wrapped in a code fence or a sentence."""
    text = (reply or "").strip()
    try:
        verdict = json.loads(text)
    except json.JSONDecodeError:
        found = re.search(r"\{.*\}", text, re.S)
        if not found:
            raise ValueError(f"no JSON in the reply {text[:200]!r}") from None
        verdict = json.loads(found[0])
    if not isinstance(verdict, dict) or verdict.get("verdict") not in ("pass", "fail"):
        raise ValueError(f"unexpected verdict {verdict!r}")
    return verdict


def clip(text: str, limit: int = MAX_PATCH_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{len(text) - limit} more characters not shown]"


def evidence(task: Task, agent_patch: str, tests: dict, test_output: str) -> str:
    """What every judge reads: the request, both diffs and the hidden tests' result."""
    reference = (task.path / "solution" / "reference.patch").read_text(errors="replace")
    return (f"## Change request ({task.meta['task']['repo']})\n\n{task.instruction.strip()}\n\n"
            f"## Merged change\n\n```diff\n{clip(reference)}\n```\n\n"
            f"## Agent's change\n\n```diff\n{clip(agent_patch)}\n```\n\n"
            f"## Hidden tests\n\n{'passed' if tests['passed'] else 'failed'}: {tests.get('summary', '')}\n\n"
            f"```\n{test_output[-3000:]}\n```")


def grade(panel: Panel, task: Task, agent_patch: str, tests: dict, test_output: str) -> dict:
    """Every judge's verdict, then the chair's: the final verdict and reason, with the panel's votes."""
    record = {"model": panel.name, "prompt_version": PROMPT_VERSION}
    try:
        user = evidence(task, agent_patch, tests, test_output)
    except OSError as exc:
        return {**record, "error": f"can't read the merged change: {exc}"}
    with ThreadPoolExecutor(len(panel.judges)) as pool:
        votes = list(pool.map(lambda j: {"label": j.name, "model": j.model, "effort": j.effort, **ask(j, SYSTEM, user)},
                              panel.judges))
    record["panel"] = votes
    answered = [v for v in votes if not v.get("error")]
    if len(answered) * 2 <= len(votes):  # a majority of the panel must answer
        return {**record, "error": "; ".join(f"{v['label']}: {v['error']}" for v in votes if v.get("error"))}
    if not panel.chair:
        return {**record, "verdict": answered[0]["verdict"], "reason": answered[0]["reason"]}
    reviews = "\n".join(f"- {v['label']}: {v['verdict']}. {v['reason']}" if not v.get("error")
                        else f"- {v['label']}: no verdict (it failed to answer)" for v in votes)
    chair = {"label": panel.chair.name, "model": panel.chair.model, "effort": panel.chair.effort,
             **ask(panel.chair, CHAIR, f"{user}\n\n## The judges' verdicts\n\n{reviews}")}
    record["chair"] = chair
    if not chair.get("error"):
        return {**record, "verdict": chair["verdict"], "reason": chair["reason"]}
    agreed = {v["verdict"] for v in answered}
    if len(answered) == len(votes) and len(agreed) == 1:  # a unanimous panel stands without its chair
        return {**record, "verdict": agreed.pop(), "reason": f"All {len(votes)} judges agreed; {answered[0]['reason']}"}
    return {**record, "error": f"{chair['label']} (chair): {chair['error']}"}


def ask(judge: Judge, system: str, user: str) -> dict:
    """One judge's verdict and reason, with what it cost when known, or {"error": ...}."""
    started = time.monotonic()
    with slot(judge):
        answer = ask_claude(judge, system, user) if judge.provider == "anthropic" else ask_chat(judge, system, user)
    return {**answer, "seconds": round(time.monotonic() - started, 1)}


@contextlib.contextmanager
def slot(judge: Judge):
    """Hold one of the model's `max_concurrent` places, shared by every role it plays in this process."""
    if not judge.max_concurrent:
        yield
        return
    with _slots_lock:
        gate = _slots.setdefault((judge.provider, judge.base_url, judge.model),
                                 threading.BoundedSemaphore(judge.max_concurrent))
    with gate:
        yield


def ask_claude(judge: Judge, system: str, user: str) -> dict:
    """A Claude model through Claude Code: print mode, no tools, a throwaway home, the contestants' credential."""
    exe = shutil.which("claude")
    credential = config.claude_credential()
    if not exe or not credential:
        return {"error": judge.problem() or "Claude Code isn't installed"}
    command = [exe, "-p", "--model", judge.model, "--output-format", "json", "--tools", "", "--strict-mcp-config",
               "--no-session-persistence", "--system-prompt", system, *(["--effort", judge.effort] if judge.effort else [])]
    last_error = None
    for attempt in range(3):  # Claude Code retries the API itself; this covers a crash or an unreadable answer
        with tempfile.TemporaryDirectory(prefix="pr-eval-judge-") as home:
            env = {"PATH": os.environ.get("PATH", ""), "HOME": home, "CLAUDE_CONFIG_DIR": home, **CLAUDE_ENV, **credential}
            try:
                done = subprocess.run(command, input=user, capture_output=True, text=True, cwd=home, env=env, timeout=600)
            except subprocess.TimeoutExpired:
                last_error = "Claude Code took over 10 minutes"
                continue
            try:
                data = json.loads(done.stdout)
                if data.get("is_error"):
                    raise ValueError(str(data.get("result") or data.get("subtype"))[:200])
                verdict = parse(data.get("result"))
            except ValueError as exc:  # also an unreadable JSON reply
                last_error = (str(exc)[:300] if done.stdout.strip()
                              else f"claude exited {done.returncode}: {done.stderr.strip()[-200:]}")
                time.sleep(3 * 2 ** attempt)
                continue
        usage = data.get("usage") or {}
        return {"verdict": verdict["verdict"], "reason": str(verdict.get("reason", "")).strip(),
                "input_tokens": sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens",
                                                                 "cache_read_input_tokens")),
                "output_tokens": usage.get("output_tokens"), "cost_usd": data.get("total_cost_usd")}
    return {"error": last_error}


def ask_chat(judge: Judge, system: str, user: str) -> dict:
    """Any OpenAI-compatible Chat Completions endpoint."""
    if not judge.api_key:
        return {"error": f"{judge.api_key_env} is not set"}
    body = json.dumps({"model": judge.model, **({"response_format": {"type": "json_object"}} if judge.json_mode else {}),
                       **({"reasoning_effort": judge.effort} if judge.effort else {}),
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    request = urllib.request.Request(f"{judge.base_url}/chat/completions", data=body, headers={
        "authorization": f"Bearer {judge.api_key}", "content-type": "application/json"})
    last_error = None
    for attempt in range(6):
        wait = min(3 * 2 ** attempt, 60)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                data = json.loads(response.read())
            verdict = parse(data["choices"][0]["message"].get("content"))
            usage = data.get("usage") or {}
            return {"verdict": verdict["verdict"], "reason": str(verdict.get("reason", "")).strip(),
                    "input_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens")}
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}"
            if exc.code < 500 and exc.code != 429:
                break
            if exc.code == 429 and (after := exc.headers.get("retry-after", "")).isdigit():
                wait = min(int(after), 120)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(wait)
    return {"error": last_error}
