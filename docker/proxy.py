# Vendored: change it upstream first, then copy it here.
"""Translating proxy: whatever shape a coding CLI speaks -> Baseten Chat Completions.

Chat Completions is the only Baseten endpoint that honors reasoning effort, so every request is converted to that
shape, the forced effort is set on it, and the answer is converted back. One place owns effort instead of three
per-CLI ceilings.

Runs as a compose sidecar in every trial (proxy/compose.yaml). Stdlib only: the container is a stock
python:3.12-slim with no pip step, and the source arrives as one base64 env var. Flags and env vars are
interchangeable; the sidecar uses the env because compose can only inject that.

    PROXY_UPSTREAM_URL=https://inference.baseten.co/v1 PROXY_EFFORT=max python proxy/proxy.py
    python proxy/proxy.py --upstream https://inference.baseten.co/v1 --effort max
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.client import HTTPResponse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator

# Seconds between SSE comment lines while an answer accumulates. A comment is spec-legal anywhere, including before
# the first event, so it keeps a client from idling out without committing to any content.
HEARTBEAT_SEC = 10

UPSTREAM_TIMEOUT_SEC = 600  # this leg is where the whole turn happens

# Reasoning knobs a client might send. All dropped, so the forced level is the only one that decides anything.
CLIENT_EFFORT_KEYS = ("reasoning_effort", "reasoning", "thinking", "output_config")

# finish_reason -> Anthropic stop_reason. A tool call overrides whatever the host says: some report `stop` alongside
# tool_calls, and an Anthropic client that reads end_turn stops driving the loop.
STOP_REASON = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use",
               "content_filter": "end_turn", "function_call": "tool_use"}

# Request path -> the wire the client is speaking. Anything else is forwarded untranslated.
SHAPES = {"/v1/messages": "anthropic", "/v1/responses": "responses", "/v1/chat/completions": "chat"}

# An upstream call returns the response, or an HTTPError, which reads like one and carries a status.
Upstream = HTTPResponse | urllib.error.HTTPError


@dataclass
class Config:
    """Everything the proxy needs to run. Built once, from flags or the env."""

    upstream: str  # ends in /v1, so a client path of /v1/<x> maps to upstream/<x>
    effort: str
    port: int
    log_file: str | None


@dataclass
class ToolCall:
    """One tool call, reassembled from however many stream fragments carried it."""

    id: str
    name: str = ""
    arguments: str = ""


@dataclass
class Answer:
    """One Chat Completions answer, folded out of the upstream stream."""

    id: str | None = None
    model: str | None = None
    text: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    error: dict[str, Any] | None = None  # a host that opened 200 and then failed mid-turn


# -----------------------------------------------------------------------------------------------------------------
# Config: flags, with the env as defaults, because compose can only inject env
# -----------------------------------------------------------------------------------------------------------------

def parse_config(argv: list[str] | None = None) -> Config:
    """Build the config from argv, defaulting every field to its env var.

    `argv=[]` reads the env only, which is what import time wants. Validity is main()'s business, so a partial
    config still builds.
    """
    parser = argparse.ArgumentParser(description="Translating proxy to Baseten Chat Completions.")
    parser.add_argument("--upstream", default=os.environ.get("PROXY_UPSTREAM_URL", ""),
                        help="Upstream base URL ending in /v1 [PROXY_UPSTREAM_URL]")
    parser.add_argument("--effort", default=os.environ.get("PROXY_EFFORT", ""),
                        help="Reasoning effort forced onto every request [PROXY_EFFORT]")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PROXY_PORT", "18787")),
                        help="Port to listen on [PROXY_PORT]")
    parser.add_argument("--log-file", default=os.environ.get("PROXY_LOG_FILE"),
                        help="Mirror the per-turn log to this file [PROXY_LOG_FILE]")
    args = parser.parse_args(argv)
    return Config(upstream=args.upstream.rstrip("/"), effort=args.effort, port=args.port, log_file=args.log_file)


# Read at import so the sidecar and the tests both work off the env; main() replaces it with the parsed flags.
CONFIG = parse_config([])

_lock = threading.Lock()
_turn = 0


def log(line: str) -> None:
    """Write one line to stdout and, if configured, to the log file harbor collects."""
    with _lock:
        print(line, flush=True)
        if CONFIG.log_file:
            with open(CONFIG.log_file, "a") as handle:
                handle.write(line + "\n")


def next_turn() -> int:
    """Number this turn, so a log line can be tied to a request."""
    global _turn
    with _lock:
        _turn += 1
        return _turn


def force_effort(chat: dict[str, Any]) -> dict[str, Any]:
    """Put the configured effort on a Chat Completions body, whatever the client asked for."""
    for key in CLIENT_EFFORT_KEYS:
        chat.pop(key, None)
    chat["reasoning_effort"] = CONFIG.effort
    return chat


# -----------------------------------------------------------------------------------------------------------------
# Anthropic Messages -> Chat Completions
# -----------------------------------------------------------------------------------------------------------------

def anthropic_to_chat(body: dict[str, Any]) -> dict[str, Any]:
    """Convert an Anthropic Messages request body into a Chat Completions one."""
    chat: dict[str, Any] = {"model": body.get("model"), "messages": _anthropic_messages(body)}
    if (limit := body.get("max_tokens")) is not None:
        chat["max_completion_tokens"] = limit
    for key in ("temperature", "top_p"):
        if key in body:
            chat[key] = body[key]
    if stop := body.get("stop_sequences"):
        chat["stop"] = stop
    # A tool without an input_schema is server-side (web_search, bash_20250124): no function to forward it as.
    if tools := [_anthropic_tool(tool) for tool in body.get("tools") or [] if tool.get("input_schema")]:
        chat["tools"] = tools
    if choice := _anthropic_tool_choice(body.get("tool_choice") or {}):
        chat["tool_choice"] = choice
    return chat


def _anthropic_messages(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten Anthropic `system` + `messages` into an OpenAI message list.

    A `tool_result` arrives inside the *user* turn following the assistant's `tool_use`, but OpenAI wants each result
    as its own `role: "tool"` message directly after the assistant message that called it, so results are emitted
    before the rest of that turn. `thinking` blocks are dropped: no Chat Completions host accepts them back, and the
    model re-reasons from the effort setting.
    """
    out: list[dict[str, Any]] = []
    if system := text_of(body.get("system")):
        out.append({"role": "system", "content": system})

    for message in body.get("messages") or []:
        role, content = message.get("role", "user"), message.get("content")
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue

        parts, tool_calls, results = _split_anthropic_blocks(content or [])
        out.extend(results)
        if tool_calls:
            out.append({"role": "assistant", "content": text_of(parts) or None, "tool_calls": tool_calls})
        elif parts:
            # Single text part goes as a plain string: some hosts reject a parts array on a system or assistant
            # message even where they accept it on a user one.
            only_text = all(part["type"] == "text" for part in parts)
            out.append({"role": role, "content": text_of(parts) if only_text else parts})
    return out


def _split_anthropic_blocks(
    blocks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Sort one turn's content blocks into (content parts, tool calls, tool results).

    `thinking` and `redacted_thinking` match nothing here and are dropped deliberately.
    """
    parts: list[dict[str, Any]] = []
    tool_calls: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []

    for block in blocks:
        kind = block.get("type")
        if kind == "text":
            parts.append({"type": "text", "text": block.get("text") or ""})
        elif kind == "image":
            parts.append(_anthropic_image(block))
        elif kind == "tool_use":
            tool_calls.append({
                "id": block.get("id") or "",
                "type": "function",
                "function": {"name": block.get("name") or "", "arguments": json.dumps(block.get("input") or {})},
            })
        elif kind == "tool_result":
            # A result may carry images; an OpenAI tool message is text-only, so only the text survives.
            results.append({"role": "tool", "tool_call_id": block.get("tool_use_id") or "",
                            "content": text_of(block.get("content")) or ""})
    return parts, tool_calls, results


def _anthropic_image(block: dict[str, Any]) -> dict[str, Any]:
    """Convert an Anthropic image block to an OpenAI image_url part (terminal-bench has vision tasks)."""
    source = block.get("source") or {}
    if source.get("type") == "url":
        url = source.get("url") or ""
    else:
        url = f"data:{source.get('media_type', 'image/png')};base64,{source.get('data', '')}"
    return {"type": "image_url", "image_url": {"url": url}}


def _anthropic_tool(tool: dict[str, Any]) -> dict[str, Any]:
    """Convert one Anthropic tool to an OpenAI function tool. Callers filter on `input_schema` first."""
    return {"type": "function", "function": {"name": tool.get("name"), "description": tool.get("description") or "",
                                             "parameters": tool["input_schema"]}}


def _anthropic_tool_choice(choice: dict[str, Any]) -> dict[str, Any] | str | None:
    """Convert an Anthropic tool_choice. Anthropic's `any` is OpenAI's `required`; a named tool nests."""
    kind = choice.get("type")
    if not kind:
        return None
    if kind == "tool":
        return {"type": "function", "function": {"name": choice.get("name")}}
    return {"any": "required", "auto": "auto", "none": "none"}.get(kind, "auto")


# -----------------------------------------------------------------------------------------------------------------
# Chat Completions -> Anthropic Messages
# -----------------------------------------------------------------------------------------------------------------

def chat_to_anthropic(answer: Answer, include_thinking: bool = True) -> dict[str, Any]:
    """Convert an accumulated answer into an Anthropic Messages response.

    Only a client that asked for thinking gets a thinking block back, hence `include_thinking`.
    """
    blocks: list[dict[str, Any]] = []
    if include_thinking and answer.reasoning:
        # No signature: the real API signs thinking to verify it on the way back, and this proxy drops thinking on
        # the way up, so there is nothing to verify.
        blocks.append({"type": "thinking", "thinking": answer.reasoning, "signature": ""})
    if answer.text:
        blocks.append({"type": "text", "text": answer.text})
    for call in answer.tool_calls:
        blocks.append({"type": "tool_use", "id": call.id, "name": call.name, "input": json_object(call.arguments)})

    return {
        "id": answer.id or "msg_proxy",
        "type": "message",
        "role": "assistant",
        "model": answer.model or "",
        # An Anthropic response always has at least one block; an empty turn would otherwise read as malformed.
        "content": blocks or [{"type": "text", "text": ""}],
        "stop_reason": "tool_use" if answer.tool_calls else STOP_REASON.get(answer.finish_reason, "end_turn"),
        "stop_sequence": None,
        "usage": usage_to_anthropic(answer.usage),
    }


def usage_to_anthropic(usage: dict[str, Any] | None) -> dict[str, int]:
    """Convert OpenAI usage to Anthropic usage.

    The one conversion that can silently corrupt a cost report: OpenAI's `prompt_tokens` INCLUDES cache reads,
    Anthropic's `input_tokens` excludes them. harbor's claude-code agent adds these back up and
    shims/claude_code_custom_rates.patch bills the remainder at the full input rate, so leaving cached tokens inside
    `input_tokens` double-charges every one.
    """
    usage = usage or {}
    prompt = usage.get("prompt_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return {"input_tokens": max(prompt - cached, 0),
            "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": 0,
            "output_tokens": usage.get("completion_tokens") or 0}


def render_anthropic_sse(resp: dict[str, Any]) -> bytes:
    """Render a complete Anthropic event stream for an already-finished response.

    Buffered rather than per-delta, which is what makes `message_start` carry real usage: `input_tokens` only
    arrives in Chat Completions' final chunk.

    ponytail: whole-block deltas, so no live token display. Per-delta needs a block-index state machine and
    re-fragmented tool JSON; add it only if a run must be watched live.
    """
    out: list[str] = []

    def emit(kind: str, data: dict[str, Any]) -> None:
        out.append(f"event: {kind}\ndata: {json.dumps({'type': kind, **data})}\n\n")

    # Mirrors the real API: the input side is known here, the output count lands in message_delta.
    emit("message_start", {"message": {**resp, "content": [], "stop_reason": None,
                                       "usage": {**resp["usage"], "output_tokens": 0}}})
    for index, block in enumerate(resp["content"]):
        opener, delta = _anthropic_block_events(block)
        emit("content_block_start", {"index": index, "content_block": opener})
        emit("content_block_delta", {"index": index, "delta": delta})
        emit("content_block_stop", {"index": index})
    emit("message_delta", {"delta": {"stop_reason": resp["stop_reason"], "stop_sequence": None},
                           "usage": resp["usage"]})
    emit("message_stop", {})
    return "".join(out).encode()


def _anthropic_block_events(block: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the (opening block, single delta) pair that carries one finished content block."""
    kind = block["type"]
    if kind == "text":
        return {"type": "text", "text": ""}, {"type": "text_delta", "text": block["text"]}
    if kind == "thinking":
        return {"type": "thinking", "thinking": ""}, {"type": "thinking_delta", "thinking": block["thinking"]}
    return ({"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}},
            {"type": "input_json_delta", "partial_json": json.dumps(block["input"])})


# -----------------------------------------------------------------------------------------------------------------
# OpenAI Responses -> Chat Completions
# -----------------------------------------------------------------------------------------------------------------

def responses_to_chat(body: dict[str, Any]) -> dict[str, Any]:
    """Convert an OpenAI Responses request body into a Chat Completions one."""
    messages: list[dict[str, Any]] = []
    if instructions := body.get("instructions"):
        messages.append({"role": "system", "content": instructions})
    payload = body.get("input")
    if isinstance(payload, str):
        messages.append({"role": "user", "content": payload})
    else:
        messages.extend(_responses_items(payload))

    chat: dict[str, Any] = {"model": body.get("model"), "messages": messages}
    if (limit := body.get("max_output_tokens")) is not None:
        chat["max_completion_tokens"] = limit
    for key in ("temperature", "top_p"):
        if key in body:
            chat[key] = body[key]

    # Responses spells a function tool flat; Chat Completions nests it under `function`.
    tools = [{"type": "function", "function": {"name": tool.get("name"), "description": tool.get("description") or "",
                                               "parameters": tool.get("parameters") or {}}}
             for tool in body.get("tools") or [] if tool.get("type") == "function"]
    if tools:
        chat["tools"] = tools

    choice = body.get("tool_choice")
    if isinstance(choice, dict) and choice.get("name"):
        chat["tool_choice"] = {"type": "function", "function": {"name": choice["name"]}}
    elif isinstance(choice, str):
        chat["tool_choice"] = choice
    return chat


def _responses_items(items: list[Any] | None) -> list[dict[str, Any]]:
    """Convert Responses `input` items into OpenAI messages.

    Consecutive `function_call` items merge into one assistant message: splitting them would put a `role: "tool"`
    reply after an assistant message that never called the tool it answers, which the host rejects. `reasoning` and
    the host-specific call types (local_shell_call, custom_tool_call) are dropped, having nothing to replay to.
    """
    out: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type") or ("message" if item.get("role") else None)
        if kind == "message":
            out.append({"role": item.get("role", "user"), "content": text_of(item.get("content"))})
        elif kind == "function_call":
            call = {"id": item.get("call_id") or item.get("id") or "", "type": "function",
                    "function": {"name": item.get("name") or "", "arguments": item.get("arguments") or "{}"}}
            if out and out[-1].get("tool_calls"):
                out[-1]["tool_calls"].append(call)
            else:
                out.append({"role": "assistant", "content": None, "tool_calls": [call]})
        elif kind == "function_call_output":
            # codex sends `output` as a plain string; the spec also allows a block list.
            result = item.get("output")
            content = result if isinstance(result, str) else text_of(result) or json.dumps(result)
            out.append({"role": "tool", "tool_call_id": item.get("call_id") or "", "content": content})
    return out


# -----------------------------------------------------------------------------------------------------------------
# Chat Completions -> OpenAI Responses
# -----------------------------------------------------------------------------------------------------------------

def chat_to_responses(answer: Answer, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Convert an accumulated answer into an OpenAI Responses response.

    `body` is the originating request, whose `instructions` and `tools` the real API echoes back.
    """
    body = body or {}
    base = answer.id or "resp_proxy"
    output: list[dict[str, Any]] = []
    if answer.reasoning:
        output.append({"type": "reasoning", "id": f"rs_{base}", "summary": [],
                       "content": [{"type": "reasoning_text", "text": answer.reasoning}]})
    if answer.text:
        output.append({"type": "message", "id": f"msg_{base}", "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": answer.text, "annotations": []}]})
    for position, call in enumerate(answer.tool_calls):
        output.append({"type": "function_call", "id": f"fc_{base}_{position}", "call_id": call.id, "name": call.name,
                       "arguments": call.arguments or "{}", "status": "completed"})

    truncated = answer.finish_reason == "length"
    return {
        "id": base,
        "object": "response",
        "created_at": int(time.time()),
        "status": "incomplete" if truncated else "completed",
        "incomplete_details": {"reason": "max_output_tokens"} if truncated else None,
        "error": None,
        "model": answer.model or "",
        "output": output,
        "instructions": body.get("instructions"),
        "tools": body.get("tools") or [],
        "parallel_tool_calls": body.get("parallel_tool_calls", True),
        "usage": usage_to_responses(answer.usage),
    }


def usage_to_responses(usage: dict[str, Any] | None) -> dict[str, Any]:
    """Convert Chat usage to Responses usage. Both are cache-inclusive, so there is no arithmetic to get wrong."""
    usage = usage or {}
    prompt = usage.get("prompt_tokens") or 0
    completion = usage.get("completion_tokens") or 0
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return {
        "input_tokens": prompt,
        "input_tokens_details": {"cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0},
        "output_tokens": completion,
        "output_tokens_details": {"reasoning_tokens": reasoning},
        "total_tokens": usage.get("total_tokens") or prompt + completion,
    }


def render_responses_sse(resp: dict[str, Any]) -> bytes:
    """Render a complete Responses event stream. codex reads the finished answer off `response.completed`."""
    out: list[str] = []
    sequence = 0

    def emit(kind: str, data: dict[str, Any]) -> None:
        nonlocal sequence
        out.append(f"event: {kind}\ndata: {json.dumps({'type': kind, 'sequence_number': sequence, **data})}\n\n")
        sequence += 1

    opening = {**resp, "status": "in_progress", "output": [], "usage": None}
    emit("response.created", {"response": opening})
    emit("response.in_progress", {"response": opening})
    for index, item in enumerate(resp["output"]):
        emit("response.output_item.added", {"output_index": index, "item": item})
        if item["type"] == "message":
            text = item["content"][0]["text"]
            common = {"output_index": index, "item_id": item["id"], "content_index": 0}
            emit("response.content_part.added",
                 {**common, "part": {"type": "output_text", "text": "", "annotations": []}})
            emit("response.output_text.delta", {**common, "delta": text})
            emit("response.output_text.done", {**common, "text": text})
            emit("response.content_part.done", {**common, "part": item["content"][0]})
        elif item["type"] == "function_call":
            common = {"output_index": index, "item_id": item["id"]}
            emit("response.function_call_arguments.delta", {**common, "delta": item["arguments"]})
            emit("response.function_call_arguments.done", {**common, "arguments": item["arguments"]})
        emit("response.output_item.done", {"output_index": index, "item": item})
    terminal = "response.incomplete" if resp["status"] == "incomplete" else "response.completed"
    emit(terminal, {"response": resp})
    return "".join(out).encode()


# -----------------------------------------------------------------------------------------------------------------
# Upstream: one Chat Completions call, folded into an Answer
# -----------------------------------------------------------------------------------------------------------------

def accumulate(resp: Any) -> Answer:
    """Fold a Chat Completions stream into one answer."""
    answer = Answer()
    for line in _sse_lines(resp):
        chunk = _sse_data(line)
        if chunk is None:
            continue

        if error := chunk.get("error"):
            # A host can open 200 and fail mid-turn (context overflow, an abort). Recorded rather than
            # skipped: an unrecorded one folds into an empty answer that reads as a clean, successful turn.
            answer.error = error if isinstance(error, dict) else {"message": str(error)}
            continue

        answer.id = answer.id or chunk.get("id")
        answer.model = answer.model or chunk.get("model")
        if usage := chunk.get("usage"):
            answer.usage = usage
        choice = (chunk.get("choices") or [{}])[0]  # the usage-only final chunk carries `choices: []`
        if reason := choice.get("finish_reason"):
            answer.finish_reason = reason
        delta = choice.get("delta") or {}
        answer.text += delta.get("content") or ""
        answer.reasoning += delta.get("reasoning_content") or delta.get("reasoning") or ""
        _merge_tool_fragments(answer.tool_calls, delta.get("tool_calls") or [])

    # A fragment whose `index` skips a slot leaves padding behind, and a call with no name is not a call -
    # it reaches the CLI as a tool_use block with an empty name, which it cannot dispatch.
    answer.tool_calls = [call for call in answer.tool_calls if call.name]
    return answer


def _merge_tool_fragments(calls: list[ToolCall], fragments: list[dict[str, Any]]) -> None:
    """Merge one delta's tool-call fragments into the calls accumulated so far.

    Fragments are keyed by `index`, the only field guaranteed on all of them: `id` and `function.name` arrive on the
    first fragment only, and `arguments` is split across as many chunks as the host feels like.
    """
    for fragment in fragments:
        slot = fragment.get("index", 0)
        while len(calls) <= slot:
            calls.append(ToolCall(id=f"call_{len(calls)}"))
        call, function = calls[slot], fragment.get("function") or {}
        if fragment.get("id"):
            call.id = fragment["id"]
        if function.get("name"):
            call.name = function["name"]
        call.arguments += function.get("arguments") or ""


def _sse_lines(resp: Any) -> Iterator[str]:
    """Yield decoded SSE lines from an upstream response."""
    buffer = b""
    while True:
        chunk = resp.read1(65536)  # read1, not read: read() blocks for the full n bytes
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            yield line.decode(errors="replace").rstrip("\r")
    if buffer:
        yield buffer.decode(errors="replace")


def _sse_data(line: str) -> dict[str, Any] | None:
    """Parse one SSE line's JSON payload, or None for a comment, a keepalive, `[DONE]` or garbage."""
    if not line.startswith("data:"):
        return None
    payload = line[len("data:"):].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        parsed = json.loads(payload)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def call_upstream(path: str, body: bytes | None, headers: dict[str, str]) -> Upstream | Exception:
    """Call the upstream host, returning a 4xx or 5xx as a readable response rather than raising.

    Returns the response, an HTTPError (which reads like one), or the exception that stopped it reaching the host.
    """
    request = urllib.request.Request(path, data=body, headers=headers, method="GET" if body is None else "POST")
    try:
        return urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SEC)
    except urllib.error.HTTPError as error:
        return error
    except Exception as error:  # a DNS or connection failure never reached the host, so there is no status
        return error


def upstream_url(path: str) -> str:
    """Map a client path onto the upstream host, whose base URL already ends in /v1."""
    tail = path[len("/v1"):] if path.startswith("/v1") else path
    return CONFIG.upstream + tail


def upstream_headers(headers: Any) -> dict[str, str]:
    """Rewrite client headers for the upstream: bearer auth from whichever header it used, plus JSON.

    The proxy holds no credential of its own. The CLI already has one, so nothing lands in the sidecar env or any
    host-side job artifact.
    """
    key = headers.get("x-api-key") or ""
    if not key and (auth := headers.get("authorization") or ""):
        key = auth.split(" ", 1)[-1] if auth.lower().startswith("bearer ") else auth
    out = {"authorization": f"Bearer {key}", "content-type": "application/json"}
    for name in ("anthropic-version", "anthropic-beta"):
        if value := headers.get(name):
            out[name] = value
    return out


def text_of(content: Any) -> str:
    """Flatten an Anthropic or Responses content field to plain text.

    Both APIs allow a bare string or a list of typed blocks in the same position, and every text-bearing block spells
    its payload `text` (`text`, `input_text`, `output_text`, `reasoning_text`), so one helper covers all.
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(block.get("text") or "" for block in content if isinstance(block, dict))


def json_object(raw: str | None) -> dict[str, Any]:
    """Parse tool arguments into an object. `{}` when the host truncated the JSON mid-call."""
    try:
        parsed = json.loads(raw or "{}")
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def error_body(detail: Exception | dict[str, Any], shape: str) -> bytes:
    """Render an exception, or an error object the upstream sent, in the shape the client speaks."""
    error = ({"type": "api_error", "message": f"{type(detail).__name__}: {detail}"}
             if isinstance(detail, Exception) else {"type": "api_error", **detail})
    envelope = {"type": "error", "error": error} if shape == "anthropic" else {"error": error}
    return json.dumps(envelope).encode()


# -----------------------------------------------------------------------------------------------------------------
# Server: route each request by the wire it speaks
# -----------------------------------------------------------------------------------------------------------------

class Proxy(BaseHTTPRequestHandler):
    """One request per turn: convert in, force the effort, convert out."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        """Silence the stdlib access log; this proxy writes one line per turn instead."""

    def do_GET(self) -> None:
        """Forward /v1/models and friends verbatim, which is enough for a CLI's model listing."""
        self._forward(0, self.path, None, "get")

    def do_POST(self) -> None:
        """Route by path: Chat Completions goes verbatim, the other two wires get translated."""
        started = time.monotonic()
        turn = next_turn()
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        path = self.path.split("?", 1)[0].rstrip("/")
        shape = next((s for p, s in SHAPES.items() if path.endswith(p)), None)

        if shape is None:
            # Any other endpoint (/v1/messages/count_tokens, ...) goes through unchanged.
            self._forward(turn, path, raw, "passthrough")
            return

        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError(f"expected a JSON object, got {type(body).__name__}")
        except ValueError as error:
            # Refused rather than forwarded: a body this proxy cannot read is one whose effort it cannot
            # force, and a turn that silently ran at the client's own level corrupts every comparison the
            # proxy exists to make. Reads empty when a client sends the body chunked, which none do today.
            self._send(400, error_body(error, shape))
            self._record(turn, started, path, shape, 400, f"unreadable body ({len(raw)}B)")
            return

        if shape == "chat":
            # Already the target shape: force the effort and leave everything else alone, the client's own
            # streaming choice included.
            self._verbatim(turn, started, path, force_effort(body))
        else:
            self._translate(turn, started, path, shape, body)

    def _forward(self, turn: int, path: str, raw: bytes | None, label: str) -> None:
        """Relay one untranslated request to the matching upstream path and log it."""
        started = time.monotonic()
        up = self._upstream(upstream_url(path), raw, "anthropic")
        if up is None:
            return
        self._relay(up)
        self._record(turn, started, path, label, up.status, "")

    def _verbatim(self, turn: int, started: float, path: str, chat: dict[str, Any]) -> None:
        """Send a Chat Completions body as-is and relay the answer, streaming it through as it arrives."""
        if chat.get("stream"):
            # `include_usage` is the only way token counts come out of a streamed call, and opencode and pi
            # both price a run from what they recorded - without it `make eval` reports $0.00 for both.
            options = chat.get("stream_options")
            options = options if isinstance(options, dict) else {}
            chat["stream_options"] = {**options, "include_usage": True}
        up = self._upstream(self._chat_url(), json.dumps(chat).encode(), "chat")
        if up is None:
            return
        if not (chat.get("stream") and up.status < 400):
            self._relay(up)
            self._record(turn, started, path, "chat", up.status, "")
            return

        self._open_stream(up.status, up.headers.get("content-type", "text/event-stream"))
        try:
            while chunk := up.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        finally:
            up.close()
            self._record(turn, started, path, "chat", up.status, "streamed")

    def _translate(self, turn: int, started: float, path: str, shape: str, body: dict[str, Any]) -> None:
        """Convert a request to Chat Completions, force the effort, and convert the answer back."""
        to_chat = anthropic_to_chat if shape == "anthropic" else responses_to_chat
        want_stream = bool(body.get("stream"))
        chat = force_effort(to_chat(body))
        # Always stream the upstream leg, whatever the client asked for: it keeps bytes moving through a long
        # answer, and `include_usage` is the only way to get token counts out of a streamed call.
        chat["stream"] = True
        chat["stream_options"] = {"include_usage": True}

        up = self._upstream(self._chat_url(), json.dumps(chat).encode(), shape)
        if up is None:
            return
        if up.status >= 400:
            # Relay the refusal untranslated but with its own status: an upstream 429 has to reach the CLI as a 429,
            # not as a 200 with an error inside it.
            payload = self._relay(up)
            self._record(turn, started, path, shape, up.status, payload[:120].decode(errors="replace"))
            return

        # Headers first, so a heartbeat can start immediately, but only now that the upstream status is known and
        # cannot still turn out to be an error.
        if want_stream:
            self._open_stream(200, "text/event-stream")
            self._beat()

        try:
            with self._heartbeat(want_stream):
                answer = accumulate(up)
            up.close()

            if answer.error or (
                not (answer.text or answer.tool_calls) and answer.finish_reason is None
            ):
                # An explicit error chunk always fails the turn, even if partial content preceded it.
                # A content-free stream without a finish reason is likewise an interrupted response.
                self._fail(turn, started, path, shape, want_stream,
                           answer.error or {"message": "upstream stream ended with no content and no finish_reason"})
                return

            if shape == "anthropic":
                wants_thinking = bool(body.get("thinking") or body.get("output_config"))
                resp = chat_to_anthropic(answer, include_thinking=wants_thinking)
                payload = render_anthropic_sse(resp) if want_stream else json.dumps(resp).encode()
            else:
                resp = chat_to_responses(answer, body)
                payload = render_responses_sse(resp) if want_stream else json.dumps(resp).encode()

            if want_stream:
                self.wfile.write(payload)
                self.wfile.flush()
            else:
                self._send(200, payload)
        except Exception as error:
            # An upstream read timeout or a conversion bug, after the status was already sent. Nothing left to
            # do but name it in proxy.log, which is where a run is read from.
            self._fail(turn, started, path, shape, want_stream, error)
            return

        self._record(turn, started, path, shape, 200,
                     f"stop={answer.finish_reason} tools={len(answer.tool_calls)} "
                     f"in={answer.usage.get('prompt_tokens')} out={answer.usage.get('completion_tokens')}"
                     + (f" partial-error={json.dumps(answer.error)[:120]}" if answer.error else ""))

    def _chat_url(self) -> str:
        """The one upstream endpoint this proxy exists to reach."""
        return CONFIG.upstream + "/chat/completions"

    def _upstream(self, url: str, body: bytes | None, shape: str) -> Upstream | None:
        """Call the upstream, answering the client with a 502 and returning None if it was never reached."""
        up = call_upstream(url, body, upstream_headers(self.headers))
        if not hasattr(up, "status"):
            self._send(502, error_body(up, shape))
            return None
        return up

    def _relay(self, up: Upstream) -> bytes:
        """Send an upstream response to the client unchanged, and return its body."""
        payload = up.read()
        up.close()
        self._send(up.status, payload, up.headers.get("content-type", "application/json"))
        return payload

    def _open_stream(self, status: int, ctype: str) -> None:
        """Send response headers for a stream the body of which is still being produced."""
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("cache-control", "no-cache")
        # One TCP connection per turn; chunked framing can come later if the turn rate ever makes it matter.
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()
        self._last_beat = time.monotonic()

    @contextmanager
    def _heartbeat(self, active: bool) -> Iterator[None]:
        """Beat an open stream from its own thread while the caller blocks on the upstream read.

        A beat driven by the read loop can never fire during the stall it exists for - waiting on the first
        token at effort=max is exactly when no read returns - so it needs a clock of its own.
        """
        if not active:
            yield
            return
        done = threading.Event()

        def beat() -> None:
            while not done.wait(HEARTBEAT_SEC):
                self._beat()

        thread = threading.Thread(target=beat, daemon=True)
        thread.start()
        try:
            yield
        finally:
            # Stopped and joined before the caller writes anything: two threads must never share self.wfile.
            done.set()
            thread.join()

    def _fail(self, turn: int, started: float, path: str, shape: str, streaming: bool,
              detail: Exception | dict[str, Any]) -> None:
        """Report a turn that died after the upstream had already answered 200, and log it."""
        body = error_body(detail, shape)
        # Logged before the write: a client that has already hung up must not cost the log line too.
        self._record(turn, started, path, shape, 502, body[:200].decode(errors="replace"))
        if streaming:
            # The status is spent, so an error event is all that is left. A CLI that ignores it still sees a
            # stream that ended without its completion event, which it reports as a failure - also correct.
            try:
                self.wfile.write(b"event: error\ndata: " + body + b"\n\n")
                self.wfile.flush()
            except Exception:
                pass  # client hung up first
        else:
            self._send(502, body)

    def _beat(self) -> None:
        """Write an SSE comment, at most every HEARTBEAT_SEC. Every parser ignores it."""
        if time.monotonic() - getattr(self, "_last_beat", 0) < HEARTBEAT_SEC:
            return
        self._last_beat = time.monotonic()
        try:
            self.wfile.write(b":\n\n")
            self.wfile.flush()
        except Exception:
            pass  # client hung up; the read loop will end on its own

    def _send(self, status: int, payload: bytes, ctype: str = "application/json") -> None:
        """Send one complete response, with its length, in one call."""
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _record(self, turn: int, started: float, path: str, shape: str, status: int, note: str) -> None:
        """Log this turn. `effort=` on every line is the authoritative record of what a run used."""
        log(f"turn={turn} {path} shape={shape} effort={CONFIG.effort} -> {status} "
            f"in {time.monotonic() - started:.1f}s" + (f" {note}" if note else ""))


def main() -> None:
    """Serve until killed, on the config the flags and env resolve to."""
    global CONFIG
    CONFIG = parse_config()
    if not CONFIG.upstream:
        sys.exit("no upstream: pass --upstream or set PROXY_UPSTREAM_URL")
    if not CONFIG.effort:
        sys.exit("no effort: pass --effort or set PROXY_EFFORT - the proxy exists to force one level")
    log(f"proxy listening on :{CONFIG.port} -> {CONFIG.upstream} forcing reasoning_effort={CONFIG.effort}")
    ThreadingHTTPServer(("", CONFIG.port), Proxy).serve_forever()


if __name__ == "__main__":
    main()
