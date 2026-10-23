"""An attempt's trace: what the agent read, ran, thought and said, step by step.

Claude Code's log of an attempt (agent.jsonl, stream-json) is large and mostly streaming
noise. The page shows a condensed copy: each message, tool call and tool result in order,
long outputs clipped, and anything that looks like a credential masked. A hosted page
gets the same condensed copy (trace.json) instead of the log itself.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

MAX_TEXT = 6000     # a message or a thought
MAX_OUTPUT = 2400   # a tool's output, head and tail
MAX_INPUT = 2400    # a command, an edit or a file written
MAX_STEPS = 800
WORKSPACE = "/workspace/"
MASK = "[redacted]"
# Keys and tokens by their shape (OpenAI, Anthropic, GitHub, Baseten), and values handed
# over as a bearer token or set on a name like a secret's. A value needs a digit, so code
# such as `token = read_token()` stays readable.
SECRET = re.compile(r"sk-(?:proj|ant|pg)-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
                    r"|\b[A-Za-z0-9]{8}\.[A-Za-z0-9]{32}\b")
HANDED = re.compile(r"((?i:bearer|api-key)\s+|(?i:api_?key|token|secret|password)[\"']?\s*[:=]\s*[\"']?)"
                    r"(?=[^\s\"']*\d)[A-Za-z0-9._~+/=-]{16,}")
SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD", re.I)


def redact(text: str) -> str:
    """`text` with credentials masked: by shape, and every secret this process holds by value."""
    for name, value in os.environ.items():
        if len(value) >= 12 and SECRET_NAME.search(name) and value in text:
            text = text.replace(value, MASK)
    return HANDED.sub(lambda m: m[1] + MASK, SECRET.sub(MASK, text))


def clip(text: str, limit: int) -> str:
    """Head and tail of a long text: the command's start and its result usually matter most."""
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return f"{text[:head]}\n… {len(text) - limit:,} characters not shown …\n{text[-(limit - head):]}"


def short(path: str) -> str:
    return path.removeprefix(WORKSPACE) if isinstance(path, str) else str(path)


def describe(tool: str, args: dict) -> tuple[str, str | None]:
    """A tool call as a one-line title and, when there is more to it, the detail."""
    a = args if isinstance(args, dict) else {}
    if tool == "Bash":
        command = str(a.get("command", ""))
        first = command.strip().splitlines()[0] if command.strip() else ""
        return first, command if "\n" in command.strip() else None
    if tool in ("Read", "NotebookRead"):
        where = short(a.get("file_path") or a.get("notebook_path") or "")
        if a.get("offset") or a.get("limit"):
            start = int(a.get("offset") or 1)
            where += f" · lines {start}–{start + int(a['limit']) - 1}" if a.get("limit") else f" · from line {start}"
        return where, None
    if tool in ("Edit", "MultiEdit"):
        edits = a.get("edits") or [a]
        diff = "\n\n".join("\n".join([*(f"- {line}" for line in str(e.get("old_string", "")).splitlines()),
                                      *(f"+ {line}" for line in str(e.get("new_string", "")).splitlines())])
                           for e in edits)
        return short(a.get("file_path", "")), diff
    if tool == "Write":
        content = str(a.get("content", ""))
        return f"{short(a.get('file_path', ''))} · {len(content.splitlines())} lines", content
    if tool == "Grep":
        return " ".join(str(p) for p in (a.get("pattern"), short(a.get("path") or ""), a.get("glob")) if p), None
    if tool == "Glob":
        return " ".join(str(p) for p in (a.get("pattern"), short(a.get("path") or "")) if p), None
    if tool == "TodoWrite":
        todos = a.get("todos") or []
        marks = {"completed": "[x]", "in_progress": "[~]"}
        return f"{len(todos)} to-dos", "\n".join(f"{marks.get(t.get('status'), '[ ]')} {t.get('content', '')}" for t in todos)
    if tool in ("Task", "Agent"):
        return str(a.get("description") or "subagent"), str(a.get("prompt") or "") or None
    if tool in ("WebFetch", "WebSearch"):
        return str(a.get("url") or a.get("query") or ""), None
    text = json.dumps(a, ensure_ascii=False)
    return (text[:160], text) if len(text) > 160 else (text, None)


def text_of(content) -> str:
    """A tool result's text: a string, or a list of text and image parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") if p.get("type") == "text" else f"[{p.get('type')}]"
                         for p in content if isinstance(p, dict))
    return "" if content is None else str(content)


def agent_seconds(trial_dir: Path) -> float | None:
    """How long the agent ran, from the attempt's result once it has one."""
    try:
        return float(json.loads((trial_dir / "result.json").read_text())["agent"]["seconds"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def condense(trial_dir: Path) -> dict | None:
    """The condensed, redacted trace of one attempt, or None before its log exists."""
    log = trial_dir / "agent.jsonl"
    if not log.is_file():
        return None
    steps: list[dict] = []
    calls: dict[str, dict] = {}
    hidden = dropped = 0
    finished = None
    times: list[tuple[dict, datetime]] = []
    with log.open(errors="replace") as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind, nested = event.get("type"), bool(event.get("parent_tool_use_id"))
            if kind == "result":
                finished = {"turns": event.get("num_turns"), "seconds": (event.get("duration_ms") or 0) / 1000 or None,
                            "error": bool(event.get("is_error")), "subtype": event.get("subtype")}
                continue
            content = (event.get("message") or {}).get("content") if kind in ("assistant", "user") else None
            if not isinstance(content, list):
                continue
            stamp = event.get("timestamp")
            for block in content:
                if not isinstance(block, dict):
                    continue
                part = block.get("type")
                if part == "tool_result":
                    if call := calls.pop(block.get("tool_use_id"), None):
                        call.update(output=clip(text_of(block.get("content")), MAX_OUTPUT), error=bool(block.get("is_error")))
                        if stamp:
                            times.append((call, datetime.fromisoformat(stamp.replace("Z", "+00:00"))))
                    continue
                if kind != "assistant":
                    continue
                if len(steps) >= MAX_STEPS:
                    dropped += 1
                    continue
                if part == "thinking":
                    if thought := (block.get("thinking") or "").strip():
                        steps.append({"kind": "thinking", "text": clip(thought, MAX_TEXT), "nested": nested})
                    else:
                        hidden += 1  # Claude's thinking reaches the log signed but empty
                elif part == "text" and (said := (block.get("text") or "").strip()):
                    steps.append({"kind": "text", "text": clip(said, MAX_TEXT), "nested": nested})
                elif part == "tool_use":
                    title, detail = describe(block.get("name", ""), block.get("input") or {})
                    step = {"kind": "tool", "tool": block.get("name", ""), "title": clip(title, 300),
                            "detail": clip(detail, MAX_INPUT) if detail else None, "nested": nested}
                    calls[block.get("id")] = step
                    steps.append(step)
    # Only tool results carry a time. The agent began its run's length before the last of
    # them (near enough: its final reply comes after), so each says how far in it finished.
    if times:
        first, last = times[0][1], times[-1][1]
        seconds = agent_seconds(trial_dir)
        start = min(first, last - timedelta(seconds=seconds)) if seconds else first
        for call, when in times:
            call["at"] = round((when - start).total_seconds())
    tools = [s for s in steps if s["kind"] == "tool"]
    trace = {"steps": steps, "hidden_thinking": hidden, "dropped": dropped, "finished": finished,
             "tool_calls": len(tools), "tool_errors": sum(1 for s in tools if s.get("error"))}
    return scrub(trace)


def scrub(value):
    """Every string in a trace, redacted."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def load(trial_dir: Path) -> dict | None:
    """An attempt's trace: condensed from its log, else the condensed copy a hosted page was given."""
    if trace := condense(trial_dir):
        return trace
    try:
        return json.loads((trial_dir / "trace.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
