"""An attempt's sandbox is set up while its task is checked. Offline: a fake runtime, no SDK or keys."""
import itertools
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import runner, runtime

SETUP_SECONDS = 0.6
MODELS = [SimpleNamespace(key=key, model=key, provider="anthropic", max_concurrent=None) for key in ("one", "two")]


class FakeRuntime:
    """Sandboxes that exist only in memory. Every step is recorded, in order, with its time."""

    def __init__(self):
        self.events, self.live, self.owner = [], set(), {}
        self.lock, self.names = threading.Lock(), itertools.count(1)

    def log(self, *event):
        with self.lock:
            self.events.append((time.monotonic(), *event))

    def first(self, *event) -> float:
        return next(at for at, *rest in self.events if tuple(rest) == event)

    def count(self, *event) -> int:
        return sum(tuple(rest) == event for _, *rest in self.events)

    def name(self, run_id):
        return f"sandbox-{next(self.names)}"

    def create(self, name, run_id, settings, memory=None):
        self.live.add(name)
        self.log("create", name)

    def delete(self, name):
        self.live.discard(name)
        self.log("delete", name)

    def cleanup(self, run_id=None, workspace=None):
        self.log("cleanup", run_id)
        removed = sorted(self.live)
        for name in removed:
            self.delete(name)
        return removed

    def prepare(self, name, task, log_dir):
        self.owner[name] = task.id
        time.sleep(SETUP_SECONDS)
        self.log("setup", name)
        return None, {"baseline": "a" * 40, "seconds": SETUP_SECONDS}

    def upload(self, name, local, remote):
        self.log("upload", name, remote)

    def set_up(self, task_id: str) -> int:
        """How many of this task's sandboxes have finished setup."""
        return sum(kind == "setup" and self.owner.get(rest[0]) == task_id for _, kind, *rest in list(self.events))

    def agents(self, task_id: str | None = None) -> list[str]:
        return [rest[0] for _, kind, *rest in self.events
                if kind == "agent" and (task_id is None or self.owner.get(rest[0]) == task_id)]


def public_task(d: Path, task_id: str = "public-task"):
    return SimpleNamespace(id=task_id, instruction="Fix the public example.", path=d,
                           meta={"task": {"repo": "public/example"}, "agent": {}, "environment": {}, "verifier": {}})


class OverlapTests(unittest.TestCase):
    def tearDown(self):
        runner.STOPPING.clear()

    def check_and_run(self, d: Path, fake: FakeRuntime, check, *, tasks=None, known=(), agent=None):
        """check_and_run with every sandbox step faked; `check(task)` stands in for validate_task.

        Tasks named in `known` passed their check earlier. Returns (on_checked calls, on_result results).
        """
        checked, results = [], []

        def run_agent(name, model, secrets, path, timeout):
            path.write_text("")
            fake.log("agent", name)
            if agent:
                agent(name)
            return {"subtype": "success", "timed_out": False}

        def validate(task, *_):
            record = check(task)
            fake.log("checked", task.id, record["status"])
            return record
        with mock.patch.object(runner, "container_name", side_effect=fake.name), \
                mock.patch.object(runner, "credential_env", return_value={}), \
                mock.patch.object(runtime, "create", side_effect=fake.create), \
                mock.patch.object(runtime, "delete", side_effect=fake.delete), \
                mock.patch.object(runtime, "cleanup", side_effect=fake.cleanup), \
                mock.patch.object(runtime, "upload", side_effect=fake.upload), \
                mock.patch.object(runtime, "download"), \
                mock.patch.object(runner, "prepare_workspace", side_effect=fake.prepare), \
                mock.patch.object(runner, "block_lookups"), \
                mock.patch.object(runner, "run_agent", side_effect=run_agent), \
                mock.patch.object(runner, "price_agent", side_effect=lambda agent, *_: agent), \
                mock.patch.object(runner, "capture_patch", return_value=("patch", "1\t0\tfile.py")), \
                mock.patch.object(runner, "sh", return_value=(0, "ok", False)), \
                mock.patch.object(runner, "set_aside_agent_tests", return_value=[]), \
                mock.patch.object(runner, "needs_check", side_effect=lambda task, _: task.id not in known), \
                mock.patch.object(runner, "validation_status", return_value="valid"), \
                mock.patch.object(runner, "validate_task", side_effect=validate):
            runner.check_and_run(tasks or [public_task(d)], MODELS, 1, d / "job",
                                 runner.Settings(workspace="eval-only", concurrency=8), "run-one",
                                 on_checked=lambda task, status, left: checked.append((task.id, status)),
                                 on_result=lambda result, done, total: results.append(result))
        return checked, results

    def wait_for_setup(self, fake: FakeRuntime, task_id: str):
        deadline = time.monotonic() + 10
        while fake.set_up(task_id) < len(MODELS):
            self.assertLess(time.monotonic(), deadline, "the attempts were never set up during the check")
            time.sleep(0.02)

    def overlapped(self, d: Path, status: str):
        """A new task whose check returns `status` once both of its attempts are set up."""
        fake = FakeRuntime()

        def check(task):
            self.wait_for_setup(fake, task.id)
            time.sleep(0.3)  # still checking, with both attempts ready to go
            return {"task_id": task.id, "status": status}
        return (fake, *self.check_and_run(d, fake, check))

    def test_the_agent_waits_for_its_tasks_check(self):
        with tempfile.TemporaryDirectory() as d:
            fake, _, results = self.overlapped(Path(d), "valid")
        checked = fake.first("checked", "public-task", "valid")
        self.assertEqual(len(fake.agents()), len(MODELS))
        for name in fake.agents():
            self.assertLess(fake.first("setup", name), checked)  # set up during the check
            self.assertGreater(fake.first("agent", name), checked)  # started only after it
        self.assertEqual(sorted(r["outcome"] for r in results), ["solved", "solved"])

    def test_a_valid_check_starts_the_agent_with_no_second_setup_wait(self):
        with tempfile.TemporaryDirectory() as d:
            fake, _, results = self.overlapped(Path(d), "valid")
        checked = fake.first("checked", "public-task", "valid")
        for result in results:
            agent, verifier = result["agent_sandbox"], result["verifier_sandbox"]
            self.assertEqual(fake.count("setup", agent), 1)
            self.assertLess(fake.first("agent", agent) - checked, SETUP_SECONDS / 2)
            self.assertEqual(result["setup"]["baseline"], "a" * 40)
            # its own sandbox gets the prompt and nothing else; the hidden tests reach the
            # verifier only once the agent's sandbox is gone
            self.assertEqual([e[3] for e in fake.events if e[1:3] == ("upload", agent)], ["/tmp/instruction.md"])
            self.assertLess(fake.first("delete", agent), fake.first("upload", verifier, "/tests"))
        self.assertEqual(fake.live, set())

    def test_a_failed_check_deletes_the_attempts_sandboxes_and_writes_no_result(self):
        with tempfile.TemporaryDirectory() as d:
            fake, checked, results = self.overlapped(Path(d), "reference-fails")
            trials = Path(d) / "job" / "trials"
            left = list(trials.iterdir()) if trials.is_dir() else []
        self.assertEqual(sum(e[1] == "create" for e in fake.events), len(MODELS))  # set up during the check
        self.assertEqual(fake.agents(), [])
        self.assertEqual(fake.live, set())
        self.assertEqual(left, [])  # no result, no folder
        self.assertEqual((checked, results), ([("public-task", "reference-fails")], []))

    def test_a_stop_while_attempts_wait_for_their_check_deletes_everything(self):
        fake = FakeRuntime()

        def check(task):
            runner.STOPPING.wait(10)
            return {"task_id": task.id, "status": "valid"}  # even a check that passes as the run stops

        def agent(name):
            if fake.owner.get(name) == "known":
                self.wait_for_setup(fake, "new")
                raise KeyboardInterrupt  # Ctrl-C, or Stop on the page, while the new task is checked
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(KeyboardInterrupt):
                self.check_and_run(Path(d), fake, check, known=("known",), agent=agent,
                                   tasks=[public_task(Path(d), "known"), public_task(Path(d), "new")])
            trials = Path(d) / "job" / "trials"
            results, new = list(trials.glob("*/result.json")), list(trials.glob("new__*"))
        self.assertEqual(fake.count("cleanup", "run-one"), 1)
        self.assertEqual(fake.agents("new"), [])
        self.assertEqual(fake.live, set())
        self.assertEqual((results, new), ([], []))


if __name__ == "__main__":
    unittest.main()
