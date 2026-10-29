"""A hung judge request is cut off and retried, so one slow judge can't hold a run. No network, no keys."""
from __future__ import annotations

import http.client
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval_sandbox import judge  # noqa: E402
from eval_sandbox.config import Judge  # noqa: E402

OLD_WAIT = 300  # what one hung request used to hold a run for
ANSWER = '{"verdict": "pass", "reason": "ok"}'


class Clock:
    """Simulated time: a hung request or a backoff moves it on without the test waiting."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float):
        self.now += seconds


def chat_reply(content: str):
    return io.BytesIO(json.dumps({"choices": [{"message": {"content": content}}]}).encode())


class HungJudgeTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        patcher = mock.patch.object(judge, "time", SimpleNamespace(monotonic=self.clock.monotonic, sleep=self.clock.sleep))
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict("os.environ", {"PR_EVAL_TEST_KEY": "k", "CLAUDE_CODE_OAUTH_TOKEN": "tok"})
        env.start()
        self.addCleanup(env.stop)

    def chat_judge(self) -> Judge:
        return Judge(model="moonshotai/Kimi-K3", label="Kimi K3", base_url="http://x", api_key_env="PR_EVAL_TEST_KEY")

    def test_a_hung_chat_request_is_retried_well_before_the_old_wait(self):
        timeouts = []

        def urlopen(request, timeout):
            timeouts.append(timeout)
            if len(timeouts) == 1:  # the provider never answers this one
                self.clock.sleep(timeout)
                raise TimeoutError("timed out")
            self.clock.sleep(9)  # the retry answers like a normal judge
            return chat_reply(ANSWER)
        with mock.patch.object(judge.urllib.request, "urlopen", side_effect=urlopen):
            graded = judge.ask(self.chat_judge(), "system", "user")
        self.assertEqual((graded["verdict"], graded["reason"]), ("pass", "ok"))
        self.assertEqual(len(timeouts), 2)
        self.assertLess(graded["seconds"], OLD_WAIT / 2)  # 120 s cut-off, 3 s backoff, 9 s answer

    def test_the_slowest_real_answer_is_not_cut_off(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(timeout)
            if timeout < 117.6:  # the slowest judge answer measured on the live page
                self.clock.sleep(timeout)
                raise TimeoutError("timed out")
            self.clock.sleep(117.6)
            return chat_reply(ANSWER)
        with mock.patch.object(judge.urllib.request, "urlopen", side_effect=urlopen):
            graded = judge.ask(self.chat_judge(), "system", "user")
        self.assertEqual(graded["verdict"], "pass")
        self.assertEqual(len(calls), 1)

    def test_a_dropped_connection_is_retried(self):
        replies = [http.client.RemoteDisconnected("Remote end closed connection without response"), chat_reply(ANSWER)]
        with mock.patch.object(judge.urllib.request, "urlopen", side_effect=replies):
            self.assertEqual(judge.ask_chat(self.chat_judge(), "system", "user")["verdict"], "pass")

    def test_a_judge_that_never_answers_is_an_error_not_a_verdict(self):
        def urlopen(request, timeout):
            self.clock.sleep(timeout)
            raise TimeoutError()
        with mock.patch.object(judge.urllib.request, "urlopen", side_effect=urlopen):
            graded = judge.ask(self.chat_judge(), "system", "user")
        self.assertEqual(graded["error"], "TimeoutError")  # an invalid attempt, never a model failure
        self.assertNotIn("verdict", graded)
        self.assertLess(graded["seconds"], 15 * 60)  # six hung requests used to hold it for over 30 minutes

    def test_a_hung_claude_code_run_is_retried_well_before_the_old_wait(self):
        timeouts = []

        def run(command, timeout, **kw):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                self.clock.sleep(timeout)
                raise subprocess.TimeoutExpired(command, timeout)
            self.clock.sleep(9)
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"result": ANSWER, "usage": {}}))
        with mock.patch.object(judge.shutil, "which", return_value="/bin/claude"), \
                mock.patch.object(judge.subprocess, "run", side_effect=run):
            graded = judge.ask(Judge(model="claude-opus-5-5", label="Claude Opus 5.5", provider="anthropic"), "system", "user")
        self.assertEqual(graded["verdict"], "pass")
        self.assertEqual(len(timeouts), 2)
        self.assertGreater(timeouts[0], 86)  # the slowest Claude judge answer measured on the live page
        self.assertLess(graded["seconds"], 600 / 3)  # it used to wait 10 minutes for Claude Code


if __name__ == "__main__":
    unittest.main()
