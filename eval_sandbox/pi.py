"""Pi (https://pi.dev), the coding agent every model runs in unless a run asks for Claude Code.

Pi runs the way a developer runs it, in print mode: its default tools and system prompt, the
repository's AGENTS.md or CLAUDE.md, and nothing else of anyone's setup. Its config directory is new
for each attempt and holds one file, models.json, saying where each provider is: the model relay on the
jail's one port. The relay passes each call on as it is, with the real key or the meter ticket on it,
so each model speaks its own provider's API: Claude the Anthropic Messages API, GPT the OpenAI
Responses API and Baseten's models OpenAI Chat Completions.

Pi writes one JSON event per line (its --mode json). This module reads them into the numbers the
report shows for every harness.
"""
from __future__ import annotations

import json
import shlex
from pathlib import Path

from .config import Model

NAME, LABEL = "pi", "Pi"
CONFIG_DIR = "/tmp/pi-agent"
# Pi's own switches for a machine with no network: no update checks, catalog refreshes or telemetry.
ENV = {"PI_CODING_AGENT_DIR": CONFIG_DIR, "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
# How Pi's catalog sends Baseten's models their requests, for the ones it doesn't list yet.
BASETEN_COMPAT = {"supportsStore": False, "supportsReasoningEffort": True, "supportsUsageInStreaming": True,
                  "maxTokensField": "max_tokens", "sendSessionAffinityHeaders": True, "thinkingFormat": "openai"}
APIS = {"anthropic": "anthropic-messages", "openai": "openai-responses", "baseten": "openai-completions"}


def models_json(model: Model, relay_url: str) -> dict:
    """Pi's models.json for one attempt: the model's provider at the relay, and the model itself when Pi's
    catalog doesn't list it (models.toml gives its limits). The relay's root stands in for the provider's
    base URL: it adds /v1 where the provider's own URL has it."""
    provider: dict = {"baseUrl": relay_url}
    if model.pi:
        entry = {"id": model.model, "name": model.label, "api": APIS[model.provider], "reasoning": True,
                 "input": ["text", "image"], "contextWindow": model.pi["context_window"],
                 "maxTokens": model.pi["max_tokens"]}
        if model.provider == "baseten":
            entry["compat"] = BASETEN_COMPAT
        provider["models"] = [entry]
    return {"providers": {model.provider: provider}}


def credential_env(placeholder_env: dict[str, str]) -> dict[str, str]:
    """The attempt's placeholder credential under the names Pi reads. A Claude subscription token is Pi's
    ANTHROPIC_OAUTH_TOKEN, which Pi recognizes by its sk-ant-oat prefix and then signs in the way that
    token needs; the relay swaps the placeholder for the real one either way."""
    env = dict(placeholder_env)
    if token := env.pop("CLAUDE_CODE_OAUTH_TOKEN", None):
        env["ANTHROPIC_OAUTH_TOKEN"] = "sk-ant-oat01-" + token
    return env


def launch(model: Model, relay_url: str) -> tuple[str, str]:
    """(shell run before the jail, the Pi command inside it). The first line Pi's log gets says which Pi
    ran: its own events don't."""
    config = json.dumps(models_json(model, relay_url))
    before = (f"mkdir -p {CONFIG_DIR} && printf '%s' {shlex.quote(config)} >{CONFIG_DIR}/models.json\n"
              f"""printf '{{"type":"harness","name":"{NAME}","version":"%s"}}\\n' "$(pi --version)"\n""")
    command = (f'pi --mode json --no-session --no-approve --model {shlex.quote(model.provider + "/" + model.model)} '
               f'--thinking {shlex.quote(model.effort)} "$(cat /tmp/instruction.md)"')
    return before, command


def events(path: Path):
    """Each JSON event of Pi's log, a line at a time: a log can be tens of MB."""
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


def compact(path: Path) -> None:
    """Keep each message once. Pi also streams every token (message_update), every tool's output so far
    (tool_execution_update) and, at the end, all messages again (agent_end): none carry anything else."""
    if not path.is_file():
        return
    tmp, dropped = path.with_suffix(".jsonl.tmp"), False
    with path.open(errors="replace") as lines, tmp.open("w") as kept:
        for line in lines:
            kind = line[:40]
            if '"type":"message_update"' in kind or '"type":"tool_execution_update"' in kind:
                dropped = True
                continue
            if '"type":"agent_end"' in kind or '"type":"turn_end"' in kind:
                line, dropped = json.dumps({"type": json.loads(line).get("type")}) + "\n", True
            kept.write(line if line.endswith("\n") else line + "\n")
    if dropped:
        tmp.replace(path)
    else:
        tmp.unlink()


def counts(usage: dict) -> dict:
    """One message's usage as Model.price reads it. Pi counts cache reads and writes apart from input,
    cacheWrite including the 1-hour part, and reasoning within output, as the providers do."""
    return {"inputTokens": int(usage.get("input") or 0), "cacheReadInputTokens": int(usage.get("cacheRead") or 0),
            "cacheCreationInputTokens": int(usage.get("cacheWrite") or 0),
            "cacheCreation1hInputTokens": int(usage.get("cacheWrite1h") or 0),
            "outputTokens": int(usage.get("output") or 0)}


def summarize(path: Path, model: Model) -> dict:
    """The numbers the report needs, out of Pi's events: the same fields as for Claude Code.

    Pi has no final report like Claude Code's, so the run counts as finished when Pi says the agent
    ended, and as an error when its last answer was one (a provider error Pi stopped retrying, say).
    Every finished answer carries its own usage; each is priced on its own, since one call can cross
    OpenAI's long-context threshold. An answer cut off by the time limit is never counted.
    """
    tool_calls: dict[str, int] = {}
    usage: dict[str, dict] = {}
    cost, priced = 0.0, True
    answers, retries, retry_ms, rate_limited = 0, 0, 0, 0
    version = last = ended = None
    for event in events(path):
        kind = event.get("type")
        if kind == "harness":
            version = event.get("version")
        elif kind == "auto_retry_start":
            # Provider backoff is time spent waiting on our rate limit, not on the model.
            retries += 1
            retry_ms += int(event.get("delayMs") or 0)
            rate_limited += "429" in str(event.get("errorMessage") or "")
        elif kind == "agent_end":
            ended = True
        elif kind == "message_end" and (message := event.get("message") or {}).get("role") == "assistant":
            answers += 1
            last = message
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    tool_calls[block.get("name", "?")] = tool_calls.get(block.get("name", "?"), 0) + 1
            call = counts(message.get("usage") or {})
            if any(call.values()):
                # A deployment may answer with its own model id: count it as the model the attempt asked for.
                model_id = message.get("model") if model.rate_for(message.get("model") or "") else model.model
                total = usage.setdefault(model_id, dict.fromkeys(call, 0))
                for key, value in call.items():
                    total[key] += value
                price = model.price_call(model_id, call)
                cost, priced = (cost + price, priced) if price is not None else (cost, False)
    summary = {"harness_version": version, "tool_calls": tool_calls, "assistant_messages": answers,
               "api_retries": retries, "rate_limited_retries": rate_limited,
               "retry_wait_seconds": round(retry_ms / 1000, 1), "model_usage": usage,
               "cost_usd": cost if usage and priced else None,
               "cost_source": "price-table" if usage and priced else "none"}
    if ended and last is not None:
        failed = last.get("stopReason") in ("error", "aborted")
        text = "\n".join(b.get("text") or "" for b in last.get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
        # An error says the most at its start ("429: ..."), an answer at its end.
        summary.update({"subtype": "error" if failed else "success", "is_error": failed, "num_turns": answers,
                        "stop_reason": last.get("stopReason"),
                        "final_message": (last.get("errorMessage") or text)[:2000] if failed else text[-2000:]})
    elif not ended and usage:
        summary["cost_source"] = "rebuilt-partial" if priced else "none"
    return summary
