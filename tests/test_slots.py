import multiprocessing
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from eval_sandbox import runner, slots


def dead_pid() -> int:
    process = multiprocessing.get_context("fork").Process(target=lambda: None)
    process.start()
    process.join()
    return process.pid


class SharedPlaces(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"PR_EVAL_SLOTS_DIR": self.dir.name, "PR_EVAL_ATTEMPTS_AT_ONCE": "2"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.dir.cleanup()

    def ticket(self, run: str, since: float, pid: int | None = None) -> dict:
        return {"id": f"{run}-{since}", "run": run, "pid": pid or os.getpid(), "since": since}

    def test_without_a_limit_nothing_is_shared(self):
        with mock.patch.dict(os.environ, {"PR_EVAL_ATTEMPTS_AT_ONCE": ""}):
            with slots.hold("attempts", "r") as held:
                self.assertTrue(held)
            self.assertIsNone(slots.usage("attempts"))
        self.assertEqual(list(Path(self.dir.name).iterdir()), [])

    def test_the_next_free_place_goes_to_the_run_holding_fewest(self):
        big1, big2, big3, small = (self.ticket("big", 1), self.ticket("big", 2), self.ticket("big", 3),
                                   self.ticket("small", 4))
        self.assertTrue(slots._take("attempts", 2, big1))
        self.assertTrue(slots._take("attempts", 2, big2))
        self.assertFalse(slots._take("attempts", 2, big3))  # full: waits
        self.assertFalse(slots._take("attempts", 2, small))
        slots._leave("attempts", big1)
        self.assertFalse(slots._take("attempts", 2, big3))  # waited longer, but its run holds one already
        self.assertTrue(slots._take("attempts", 2, small))
        self.assertEqual(slots.usage("attempts"), {"held": 2, "waiting": 1, "limit": 2})

    def test_a_dead_process_gives_its_places_back(self):
        gone = dead_pid()
        self.assertTrue(slots._take("attempts", 2, self.ticket("crashed", 1, gone)))
        self.assertTrue(slots._take("attempts", 2, self.ticket("crashed", 2, gone)))
        self.assertTrue(slots._take("attempts", 2, self.ticket("live", 3)))

    def test_a_run_stopping_while_it_waits_gets_no_place(self):
        self.assertTrue(slots._take("attempts", 2, self.ticket("other", 1)))
        self.assertTrue(slots._take("attempts", 2, self.ticket("other", 2)))
        with mock.patch.object(slots, "POLL_SECONDS", 0.01), slots.hold("attempts", "r", stopping=lambda: True) as held:
            self.assertFalse(held)
        self.assertEqual(slots.usage("attempts")["waiting"], 0)  # it left the line too

    def test_runs_never_hold_more_than_the_limit_in_all(self):
        holding, most, lock = 0, 0, threading.Lock()

        def attempt(run: str):
            nonlocal holding, most
            with slots.hold("attempts", run) as held:
                self.assertTrue(held)
                with lock:
                    holding += 1
                    most = max(most, holding)
                time.sleep(0.02)
                with lock:
                    holding -= 1

        with mock.patch.object(slots, "POLL_SECONDS", 0.005):
            threads = [threading.Thread(target=attempt, args=(f"run{i % 3}",)) for i in range(9)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(most, 2)
        self.assertEqual(slots.usage("attempts"), {"held": 0, "waiting": 0, "limit": 2})

    def test_a_runs_checks_take_no_place_so_attempts_waiting_on_them_never_block_them(self):
        order = []
        with mock.patch.object(slots, "POLL_SECONDS", 0.005), mock.patch.dict(os.environ, {"PR_EVAL_ATTEMPTS_AT_ONCE": "1"}):
            checked = threading.Event()

            def work(job):
                kind, name = job
                if kind == "check":
                    order.append(name)
                    checked.set()
                else:
                    self.assertTrue(checked.wait(5))  # an attempt set up beside its check waits for it, holding its place
                    order.append(name)
                return {}

            runner.in_parallel([("early", "attempt"), ("check", "check")], work, 2, "r",
                               needs_place=lambda job: job[0] != "check")
        self.assertEqual(order, ["check", "attempt"])


if __name__ == "__main__":
    unittest.main()
