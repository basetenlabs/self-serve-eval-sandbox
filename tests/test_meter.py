"""The key meter: a call from a trial's sandbox, the agent's or the repository's code's, counts toward the limits.

Everything runs on 127.0.0.1: a fake provider, the meter in front of it, and the calls a sandbox would make.
"""
from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eval_sandbox import app, meter, rundir, runner  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_pr_eval as base  # noqa: E402
from test_pr_eval import anthropic_model, baseten_model  # noqa: E402

REAL_KEY = "sk-real-anthropic-key-for-tests"


class FakeProvider(http.server.BaseHTTPRequestHandler):
    """Answers like Anthropic (streamed Messages) and Baseten (Chat Completions), and remembers what it got."""
    protocol_version = "HTTP/1.1"
    seen: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeProvider.seen.append((self.path, dict(self.headers), body))
        if self.path.startswith("/v1/messages"):
            usage = body.get("fake_usage", {"input_tokens": 1_000_000, "output_tokens": 0})
            events = [{"type": "message_start", "message": {"id": "m1", "usage": {**usage, "output_tokens": 1}}},
                      {"type": "content_block_delta", "delta": {"text": "hi"}},
                      {"type": "message_delta", "usage": {"output_tokens": usage["output_tokens"]}},
                      {"type": "message_stop"}]
            payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
            kind = "text/event-stream"
        else:
            payload = json.dumps({"choices": [], "usage": {"prompt_tokens": 2_000_000, "completion_tokens": 100_000,
                                                           "prompt_tokens_details": {"cached_tokens": 1_000_000}}}).encode()
            kind = "application/json"
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class MeterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.jobs = Path(self.tmp.name)
        provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        self.server = meter.serve(self.jobs, 0, "127.0.0.1")
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        fake = f"http://127.0.0.1:{provider.server_address[1]}"
        patches = [mock.patch.dict(meter.UPSTREAMS, {"anthropic": fake, "baseten": fake}),
                   mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": REAL_KEY, "BASETEN_API_KEY": "baseten-real-key"}),
                   mock.patch.object(meter, "claude_credential", return_value={"ANTHROPIC_API_KEY": REAL_KEY})]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        for server in (provider, self.server):
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        self.addCleanup(self.tmp.cleanup)
        FakeProvider.seen = []

    def attempt(self, run_id: str, owner: str | None, model=None) -> tuple[str, Path]:
        """A going run with one attempt holding a ticket, as run_trial sets it up; returns the ticket."""
        base.AppTest.add_run(self.jobs, run_id, owner)
        trial_dir = self.jobs / run_id / "trials" / "t__m__1"
        trial_dir.mkdir(parents=True)
        env, headers, path = meter.admit(model or anthropic_model(), trial_dir, "ANTHROPIC_API_KEY")
        self.assertTrue(env["ANTHROPIC_API_KEY"].startswith("pr-eval-placeholder-"))
        self.assertEqual(list(headers), [meter.HEADER])  # what the attempt's relay puts on each call
        return headers[meter.HEADER], path

    def call(self, ticket: str | None, path: str, body: dict) -> tuple[int, bytes]:
        """What reaches the meter from a sandbox: a call with a placeholder key, and the ticket its relay added."""
        headers = {"content-type": "application/json", "x-api-key": "pr-eval-placeholder-x"}
        if ticket:
            headers[meter.HEADER] = ticket
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read()

    def ledger(self, run_id: str, wait: bool = True) -> list[dict]:
        """The run's charges; the meter writes one just after the answer's last byte, so wait a moment for it."""
        path = self.jobs / run_id / rundir.SPEND_LEDGER
        for _ in range(250 if wait else 1):
            # The file exists from the moment the meter opens it, before the charge's line is in it.
            if path.is_file() and (text := path.read_text()).endswith("\n"):
                return [json.loads(line) for line in text.splitlines()]
            time.sleep(0.02)
        return []

    def test_repo_code_calling_mid_attempt_is_charged_and_trips_the_limit(self):
        ticket, _ = self.attempt("going", "a@x.co")
        # Repository code, not the agent, asks for 1M input tokens and 2M output tokens of Opus.
        status, payload = self.call(ticket, "/anthropic/v1/messages?beta=true", {
            "model": "claude-opus-5-5", "stream": True, "max_tokens": 10,
            "fake_usage": {"input_tokens": 1_000_000, "output_tokens": 2_000_000}})
        self.assertEqual(status, 200)
        self.assertIn(b"message_stop", payload)  # the stream reaches the caller whole
        path, headers, _ = FakeProvider.seen[-1]
        self.assertEqual(path, "/v1/messages?beta=true")
        self.assertEqual(headers.get("X-Api-Key"), REAL_KEY)  # the real key, added by the meter
        self.assertNotIn(meter.HEADER, headers)  # the ticket stops at the meter
        [entry] = self.ledger("going")
        self.assertEqual((entry["kind"], entry["trial"], entry["model"]), ("call", "t__m__1", "claude-opus-5-5"))
        self.assertAlmostEqual(entry["usd"], 1 * 4.0 + 2 * 20.0)  # $44 at the test model's rates
        with mock.patch.object(app, "SPEND_PER_PERSON", 40.0), mock.patch.object(app, "SPEND_TOTAL", 1000.0), \
                mock.patch.object(app, "alive", return_value=True), mock.patch.object(app.os, "kill") as kill, \
                contextlib.redirect_stdout(io.StringIO()):
            page = app.App(self.jobs)
            spent, by_owner = app.spending(page.everyone())
            self.assertAlmostEqual(by_owner["a@x.co"], 44.0)
            self.assertEqual(page.enforce_spending(), ["going"])  # the 30-second watch stops the run
            kill.assert_called_once()
        # And the meter refuses the run's next call at once, before the run has even stopped.
        status, payload = self.call(ticket, "/anthropic/v1/messages", {"model": "claude-opus-5-5"})
        self.assertEqual(status, 402)
        self.assertIn(b"stopped for spending", payload)
        self.assertEqual(len(FakeProvider.seen), 1)

    def test_chat_completions_on_baseten_are_priced_from_their_usage(self):
        ticket, _ = self.attempt("glm", "a@x.co", baseten_model())
        status, _ = self.call(ticket, "/baseten/v1/chat/completions", {"model": "zai-org/GLM-5.3"})
        self.assertEqual(status, 200)
        self.assertEqual(FakeProvider.seen[-1][1].get("Authorization"), "Bearer baseten-real-key")
        [entry] = self.ledger("glm")
        self.assertAlmostEqual(entry["usd"], (1_000_000 * 1.40 + 1_000_000 * 0.14 + 100_000 * 4.40) / 1e6)

    def test_calls_without_a_live_ticket_and_owner_are_refused(self):
        ticket, path = self.attempt("mine", "a@x.co")
        orphan, _ = self.attempt("ownerless", None)
        body = {"model": "claude-opus-5-5"}
        self.assertEqual(self.call(None, "/anthropic/v1/messages", body)[0], 401)
        self.assertEqual(self.call("mine.not-the-secret", "/anthropic/v1/messages", body)[0], 401)
        self.assertEqual(self.call("../mine." + ticket.rpartition(".")[2], "/anthropic/v1/messages", body)[0], 401)
        self.assertEqual(self.call(orphan, "/anthropic/v1/messages", body)[0], 403)  # no owner to charge
        # The attempt's provider only: the meter would otherwise spend the other provider's key.
        self.assertEqual(self.call(ticket, "/baseten/v1/chat/completions", {"model": "zai-org/GLM-5.3"})[0], 403)
        # Only what it can price: no model without a price, no endpoint whose usage it can't read.
        self.assertEqual(self.call(ticket, "/anthropic/v1/messages", {"model": "claude-mythos-5"})[0], 403)
        self.assertEqual(self.call(ticket, "/anthropic/v1/messages/batches", body)[0], 403)
        path.unlink()  # the agent stopped: run_trial revokes the ticket
        self.assertEqual(self.call(ticket, "/anthropic/v1/messages", body)[0], 401)
        self.assertEqual(FakeProvider.seen, [])
        self.assertEqual(self.ledger("mine", False) + self.ledger("ownerless", False), [])

    def test_a_call_whose_usage_never_comes_back_counts_its_worst_case(self):
        self.assertEqual(meter.worst_case({}, {"max_tokens": 1000}, b"x" * 500), {"inputTokens": 500, "outputTokens": 1000})
        # Cut off after message_start: its input counts, and the whole output it allowed itself.
        usage = meter.Usage("anthropic")
        usage.feed(b'data: {"type": "message_start", "message": {"usage": {"input_tokens": 7, "output_tokens": 1}}}\n')
        self.assertFalse(usage.final)
        counts = meter.worst_case(meter.usage_counts("anthropic", usage.found), {"max_tokens": 1000}, b"x" * 500)
        self.assertEqual((counts["inputTokens"], counts["outputTokens"]), (7, 1000))
        usage.feed(b'data: {"type": "message_delta", "usage": {"output_tokens": 20}}\n')
        self.assertTrue(usage.final)

    def test_the_caller_never_picks_the_host_the_key_goes_to(self):
        ticket, _ = self.attempt("mine", "a@x.co")
        for path in ("/anthropic@evil.example/v1/messages", "/anthropic/../v1/messages", "/anthropic/v1/../../x"):
            self.assertEqual(self.call(ticket, path, {"model": "claude-opus-5-5"})[0], 403, path)
        self.assertEqual(FakeProvider.seen, [])
        # http.server folds a leading "//" to "/" itself; the call still goes to the provider's own host.
        self.assertEqual(self.call(ticket, "//anthropic/v1/messages", {"model": "claude-opus-5-5"})[0], 200)
        self.assertEqual([seen[0] for seen in FakeProvider.seen], ["/v1/messages"])


class MeteredAttemptTest(unittest.TestCase):
    def test_a_metered_agent_talks_to_the_meter_only(self):
        url = "https://eval-meter.example"
        for model, path in ((anthropic_model(), "/anthropic"), (baseten_model(), "/baseten/v1")):
            relay, script, env = runner.agent_script(model, url)
            self.assertIn(f"--upstream {url}{path} ", relay)
            self.assertEqual(env["ANTHROPIC_BASE_URL"], f"http://127.0.0.1:{runner.PROXY_PORT}")  # the relay, never the meter
            self.assertNotIn(url, script + json.dumps(env))

    def test_an_attempt_outside_a_run_has_nothing_to_meter(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaises(runner.runtime.RuntimeError):
            meter.admit(anthropic_model(), Path(d) / "check", "ANTHROPIC_API_KEY")


if __name__ == "__main__":
    unittest.main()
