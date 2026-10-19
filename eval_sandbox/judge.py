"""LLM judge: does the agent's diff do what the merged PR did?

The hidden tests are the first check. The judge is the second: it reads the request,
the merged diff and the agent's diff, and catches what tests miss (a change that games
the tests, edits them, or only half-implements the request). It returns pass or fail
with a one-sentence reason, which the report shows next to every attempt.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from .config import Judge
from .tasks import Task

MAX_PATCH_CHARS = 60_000

PROMPT_VERSION = 2
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


def clip(text: str, limit: int = MAX_PATCH_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{len(text) - limit} more characters not shown]"


def grade(judge: Judge, task: Task, agent_patch: str, tests: dict, test_output: str) -> dict:
    if not judge.api_key:
        return {"error": f"{judge.api_key_env} is not set"}
    reference = (task.path / "solution" / "reference.patch").read_text(errors="replace")
    user = (f"## Change request ({task.meta['task']['repo']})\n\n{task.instruction.strip()}\n\n"
            f"## Merged change\n\n```diff\n{clip(reference)}\n```\n\n"
            f"## Agent's change\n\n```diff\n{clip(agent_patch)}\n```\n\n"
            f"## Hidden tests\n\n{'passed' if tests['passed'] else 'failed'}: {tests.get('summary', '')}\n\n"
            f"```\n{test_output[-3000:]}\n```")
    body = json.dumps({"model": judge.model, "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]}).encode()
    request = urllib.request.Request(f"{judge.base_url}/chat/completions", data=body, headers={
        "authorization": f"Bearer {judge.api_key}", "content-type": "application/json"})
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                data = json.loads(response.read())
            verdict = json.loads(data["choices"][0]["message"]["content"])
            if verdict.get("verdict") not in ("pass", "fail"):
                raise ValueError(f"unexpected verdict {verdict!r}")
            usage = data.get("usage") or {}
            return {"verdict": verdict["verdict"], "reason": str(verdict.get("reason", "")).strip(),
                    "model": judge.model, "prompt_version": PROMPT_VERSION, "input_tokens": usage.get("prompt_tokens"),
                    "output_tokens": usage.get("completion_tokens")}
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}"
            if exc.code < 500 and exc.code != 429:
                break
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(2 ** attempt * 3)
    return {"error": last_error, "model": judge.model}
