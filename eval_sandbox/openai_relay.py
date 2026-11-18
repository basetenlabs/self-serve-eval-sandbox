"""Claude Code Messages to OpenAI Responses. Runs outside the trial jail with the image's model relay."""
from __future__ import annotations

import json
import sys
import threading
import time
from collections import OrderedDict
from typing import Any

# The runner supplies this source to isolated Python in the trial. Only the image owns this directory.
if __name__ == "__main__":
    sys.path.insert(0, "/opt/eval")
import proxy


# This relay asks OpenAI to keep no stored response. Carry encrypted reasoning from tool calls to the
# next turn in this single attempt's relay. Parallel calls made by one answer share its reasoning.
_reasoning_by_call: OrderedDict = OrderedDict()
_reasoning_lock = threading.Lock()


def response_parts(content: Any) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}] if content else []
    parts = []
    for block in content or []:
        if block["type"] == "text":
            parts.append({"type": "input_text", "text": block["text"]})
        elif block["type"] == "image":
            image = block["source"]
            if image.get("type") != "base64":
                raise ValueError("Only inline image data is supported")
            parts.append({"type": "input_image", "image_url": f"data:{image['media_type']};base64,{image['data']}"})
        else:
            raise ValueError(f"Unsupported content block {block['type']}")
    return parts


def anthropic_to_responses(body: dict, model: str, effort: str) -> dict:
    items = []
    for msg in body["messages"]:
        role, content = msg["role"], msg["content"]
        for block in ([{"type": "text", "text": content}] if isinstance(content, str) else content):
            kind = block["type"]
            if kind == "tool_use":
                with _reasoning_lock:
                    items.extend(_reasoning_by_call.get(block["id"], []))
                items.append({"type": "function_call", "call_id": block["id"], "name": block["name"],
                              "arguments": json.dumps(block["input"])})
            elif kind == "tool_result":
                parts = response_parts(block.get("content"))
                if block.get("is_error"):
                    parts.insert(0, {"type": "input_text", "text": "Tool returned an error."})
                items.append({"type": "function_call_output", "call_id": block["tool_use_id"],
                              "output": parts or "(no output)"})
            elif kind not in ("thinking", "redacted_thinking"):
                items.append({"role": role, "content": block["text"] if kind == "text" else response_parts([block])})
    request = {"model": model, "instructions": proxy.text_of(body.get("system")), "input": items, "store": False,
               "include": ["reasoning.encrypted_content"], "reasoning": {"effort": effort}, "service_tier": "default"}
    if limit := body.get("max_tokens"):
        request["max_output_tokens"] = max(16, min(limit, 128_000))
    if tools := [t for t in body.get("tools", []) if t.get("input_schema")]:
        request["tools"] = [{"type": "function", "name": t["name"], "description": t.get("description", ""),
                             "parameters": t["input_schema"], "strict": False} for t in tools]
        choice = body.get("tool_choice") or {}
        if choice.get("type") == "tool":
            request["tool_choice"] = {"type": "function", "name": choice["name"]}
        elif choice.get("type") in ("any", "auto", "none"):
            request["tool_choice"] = {"any": "required"}.get(choice["type"], choice["type"])
        request["parallel_tool_calls"] = not choice.get("disable_parallel_tool_use", False)
    return request


def response_to_anthropic(data: dict) -> dict:
    reason = (data.get("incomplete_details") or {}).get("reason")
    limited = data.get("status") == "incomplete" and reason == "max_output_tokens"
    if not limited and data.get("status") != "completed":
        raise ValueError(f"OpenAI response status {data.get('status')}")
    blocks, reasoning, stop = [], [], "end_turn"
    for item in data.get("output", []):
        if item["type"] == "reasoning" and item.get("encrypted_content"):
            reasoning.append({k: item[k] for k in ("type", "encrypted_content", "summary") if k in item})
        elif item["type"] == "function_call":
            if reasoning:
                with _reasoning_lock:
                    _reasoning_by_call[item["call_id"]] = reasoning
                    if len(_reasoning_by_call) > 256:
                        _reasoning_by_call.popitem(last=False)
                reasoning = []
            if limited and item.get("status") == "incomplete":
                continue
            blocks.append({"type": "tool_use", "id": item["call_id"], "name": item["name"],
                           "input": json.loads(item["arguments"])})
            stop = "tool_use"
        elif item["type"] == "message":
            blocks.extend({"type": "text", "text": b.get("text") or b.get("refusal") or ""}
                          for b in item["content"] if b["type"] in ("output_text", "refusal"))
    usage = data["usage"]
    details = usage.get("input_tokens_details") or {}
    cached, written = details.get("cached_tokens", 0), details.get("cache_write_tokens", 0)
    return {"type": "message", "id": data["id"], "role": "assistant", "model": data["model"],
            "content": blocks or [{"type": "text", "text": ""}], "stop_sequence": None,
            "stop_reason": "max_tokens" if limited else stop,
            "usage": {"input_tokens": usage["input_tokens"] - cached - written, "cache_read_input_tokens": cached,
                      "cache_creation_input_tokens": written, "output_tokens": usage["output_tokens"]}}


class ResponsesRelay(proxy.Proxy):
    model: str

    def do_GET(self):
        self._send(404, proxy.error_body(ValueError("Only Messages is available on this relay"), "anthropic"))

    def do_POST(self) -> None:
        started, turn = time.monotonic(), proxy.next_turn()
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        path = self.path.partition("?")[0]
        if path != "/v1/messages":
            return self._send(404, proxy.error_body(ValueError("Only Messages is available on this relay"), "anthropic"))
        try:
            body = json.loads(raw)
            request = anthropic_to_responses(body, self.model, proxy.CONFIG.effort)
        except (KeyError, TypeError, ValueError) as exc:
            return self._send(400, proxy.error_body(exc, "anthropic"))
        upstream = self._upstream(proxy.CONFIG.upstream + "/responses", json.dumps(request).encode(), "anthropic")
        if upstream is None:
            return
        with upstream:
            if upstream.status >= 400:
                self._relay(upstream)
                return self._record(turn, started, path, "responses", upstream.status, "")
            try:
                response = response_to_anthropic(json.load(upstream))
            except (KeyError, TypeError, ValueError) as exc:
                return self._fail(turn, started, path, "anthropic", False, exc)
        # Per-request counts preserve context-tier pricing even after Claude Code aggregates the session.
        self._record(turn, started, path, "responses", 200, "usage=" + json.dumps(response["usage"]))
        if body.get("stream"):
            self._send(200, proxy.render_anthropic_sse(response), "text/event-stream")
        else:
            self._send(200, json.dumps(response).encode())


if __name__ == "__main__":
    ResponsesRelay.model = sys.argv.pop(1)
    proxy.CONFIG = proxy.parse_config()
    proxy.keep_credential_private()
    with proxy.UnixServer(proxy.CONFIG.socket, ResponsesRelay) as server:
        server.serve_forever()
