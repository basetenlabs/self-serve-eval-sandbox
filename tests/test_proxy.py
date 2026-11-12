import http.client
import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location("eval_proxy", Path(__file__).parents[1] / "docker" / "proxy.py")
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class ReasoningGoesBack(unittest.TestCase):
    """DeepSeek reads prior steps' reasoning from `reasoning_content`; without it every step re-reasons."""

    def test_anthropic_thinking_rides_on_the_assistant_tool_call(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "user", "content": "fix the parser"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Read the parser first.", "signature": ""},
                {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "p.py"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "code"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Found it."}, {"type": "text", "text": "Done."}]},
        ]})
        assistants = [m for m in chat["messages"] if m["role"] == "assistant"]
        self.assertEqual([m.get("reasoning_content") for m in assistants], ["Read the parser first.", "Found it."])
        self.assertEqual(assistants[0]["tool_calls"][0]["id"], "t1")
        self.assertNotIn("reasoning_content", chat["messages"][0])

    def test_a_thinking_only_message_hands_its_reasoning_to_the_next_assistant_message(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "Plan."}]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]},
        ]})
        self.assertEqual([m["role"] for m in chat["messages"]], ["user", "assistant"])
        self.assertEqual(chat["messages"][1]["reasoning_content"], "Plan.")

    def test_redacted_thinking_and_user_turns_carry_no_reasoning(self):
        chat = proxy.anthropic_to_chat({"model": "m", "messages": [
            {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "x"},
                                              {"type": "text", "text": "hi"}]},
        ]})
        self.assertEqual(chat["messages"], [{"role": "assistant", "content": "hi"}])

    def test_responses_reasoning_item_rides_on_the_following_call(self):
        chat = proxy.responses_to_chat({"model": "m", "input": [
            {"type": "message", "role": "user", "content": "go"},
            {"type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "Plan."}]},
            {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"},
            {"type": "function_call", "call_id": "c2", "name": "shell", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "c1", "output": "ok"},
        ]})
        call = chat["messages"][1]
        self.assertEqual((call["reasoning_content"], len(call["tool_calls"])), ("Plan.", 2))

    def test_streamed_reasoning_comes_back_as_a_thinking_block(self):
        answer = proxy.Answer(reasoning="Plan.", text="ok", finish_reason="stop")
        self.assertEqual(proxy.chat_to_anthropic(answer)["content"][0]["thinking"], "Plan.")


class RateLimitsAreWaitedOut(unittest.TestCase):
    """A run's attempts share one key; a provider's 429s are waited out here, not handed to Claude Code,
    whose 10 quick retries lost GLM-5.3 Fast attempts to "Rate limit exceeded" on the hosted page."""

    def answer(self, status, retry_after=None):
        headers = {"retry-after": retry_after} if retry_after else {}
        return SimpleNamespace(status=status, headers=headers, read=lambda: b"{}", close=lambda: None)

    def ask(self, answers):
        handler = object.__new__(proxy.Proxy)
        handler.headers = {}
        sleeps, lines = [], []
        with mock.patch.object(proxy, "call_upstream", side_effect=answers), \
                mock.patch.object(proxy.time, "sleep", sleeps.append), \
                mock.patch.object(proxy, "log", lines.append):
            up = handler._upstream("https://example.invalid/v1/chat/completions", b"{}", "anthropic")
        return up, sleeps, lines

    def test_a_429_is_asked_again_until_the_provider_answers(self):
        up, sleeps, lines = self.ask([self.answer(429, "3"), self.answer(429), self.answer(200)])
        self.assertEqual(up.status, 200)
        self.assertEqual(len(sleeps), 2)
        self.assertEqual(sleeps[0], 3.0)
        self.assertRegex(lines[0], r"^rate-limited: waited [\d.]+s over 2 retries, then 200$")

    def test_the_429_goes_back_once_the_wait_is_spent(self):
        up, sleeps, lines = self.ask([self.answer(429, "30")] * 20)
        self.assertEqual(up.status, 429)
        self.assertEqual(sum(sleeps), proxy.RATE_LIMIT_WAIT_SEC)
        self.assertIn("then 429", lines[0])

    def test_other_errors_go_straight_back(self):
        up, sleeps, lines = self.ask([self.answer(500)])
        self.assertEqual((up.status, sleeps, lines), (500, [], []))


class Upstream(BaseHTTPRequestHandler):
    """A provider that remembers what reached it and answers with a short stream."""
    protocol_version = "HTTP/1.1"
    seen: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))
        Upstream.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        payload = b"event: message_stop\ndata: {}\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class OverSocket(http.client.HTTPConnection):
    """An HTTP client on a Unix socket: what the jail's bridge is to the agent."""

    def __init__(self, path: str):
        super().__init__("localhost", timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


class TheRelayIsTheAgentsOneWayOut(unittest.TestCase):
    """No effort to force (a Claude model): requests pass as they are, signed with a credential the agent never has."""

    def setUp(self):
        Upstream.seen = []
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")  # a socket's path has to be short
        self.path = os.path.join(self.tmp.name, "relay.sock")
        config = proxy.Config(upstream=f"http://127.0.0.1:{upstream.server_address[1]}", effort="", port=0, log_file=None,
                              socket=self.path, headers={"X-Api-Key": "the-real-key"})
        patches = [mock.patch.object(proxy, "CONFIG", config), mock.patch.object(proxy, "log")]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        relay = proxy.UnixServer(self.path, proxy.Proxy)
        for server in (upstream, relay):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        self.addCleanup(self.tmp.cleanup)

    def ask(self, target: str, headers: dict) -> tuple[int, bytes]:
        connection = OverSocket(self.path)
        connection.request("POST", target, body=b'{"model": "claude-opus-5-5"}',
                           headers={"content-type": "application/json", **headers})
        response = connection.getresponse()
        answer = response.status, response.read()
        connection.close()
        return answer

    def test_the_relay_signs_each_call_with_its_own_credential_in_place_of_the_agents(self):
        status, body = self.ask("/v1/messages?beta=true", {"x-api-key": "pr-eval-placeholder-1", "authorization": "Bearer pr-eval-placeholder-2",
                                                            "anthropic-version": "2023-06-01"})
        self.assertEqual((status, body), (200, b"event: message_stop\ndata: {}\n\n"))
        (path, headers, sent), = Upstream.seen
        self.assertEqual((path, sent), ("/v1/messages?beta=true", b'{"model": "claude-opus-5-5"}'))
        self.assertEqual(headers["x-api-key"], "the-real-key")
        self.assertNotIn("authorization", headers)  # no second sign-in beside the relay's
        self.assertEqual(headers["anthropic-version"], "2023-06-01")
        self.assertNotIn("placeholder", json.dumps(headers))

    def test_the_agent_never_picks_the_host_the_credential_goes_to(self):
        for target in ("@evil.example/v1/messages", "http://evil.example/v1/messages", ".evil.example/x"):
            with self.subTest(target):
                self.assertEqual(self.ask(target, {"x-api-key": "pr-eval-placeholder-1"})[0], 400)
        self.assertEqual(Upstream.seen, [])

    def test_the_credential_comes_from_the_environment_and_then_leaves_it(self):
        secret = {"PROXY_UPSTREAM_HEADERS": '{"Authorization": "Bearer the-real-key"}'}
        with mock.patch.dict(os.environ, secret):
            config = proxy.parse_config(["--upstream", "https://api.example", "--socket", "/logs/relay.sock"])
            self.assertEqual(config.headers, {"Authorization": "Bearer the-real-key"})
            self.assertEqual((config.effort, config.socket), ("", "/logs/relay.sock"))
            proxy.keep_credential_private()
            self.assertNotIn("PROXY_UPSTREAM_HEADERS", os.environ)  # nothing the relay starts inherits it
            if os.path.exists("/proc/self/environ"):  # nor does /proc still show what it started with
                self.assertNotIn(b"the-real-key", Path("/proc/self/environ").read_bytes())
        for bad in ("not json", '["a list"]', '{"X-Api-Key": 5}'):
            with self.subTest(bad), mock.patch.dict(os.environ, {"PROXY_UPSTREAM_HEADERS": bad}), self.assertRaises(SystemExit):
                proxy.parse_config([])

    def test_a_bearer_credential_replaces_an_api_key_sign_in_too(self):
        held = proxy.Config(upstream="https://api.example", effort="high", port=0, log_file=None,
                            headers={"Authorization": "Bearer the-real-key"})
        with mock.patch.object(proxy, "CONFIG", held):
            signed = proxy.with_credential({"X-Api-Key": "pr-eval-placeholder-1", "authorization": "Bearer placeholder",
                                            "Content-Type": "application/json"})
        self.assertEqual(signed, {"Content-Type": "application/json", "Authorization": "Bearer the-real-key"})
        with mock.patch.object(proxy, "CONFIG", proxy.Config(upstream="https://api.example", effort="high", port=0, log_file=None)):
            self.assertEqual(proxy.with_credential({"Authorization": "Bearer the-clients-own"}),
                             {"Authorization": "Bearer the-clients-own"})  # a relay with no credential of its own


if __name__ == "__main__":
    unittest.main()
