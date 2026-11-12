"""Offline transport and lifecycle tests for the trial sandboxes. No network, sandbox or keys."""
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eval_sandbox import baseten, causes, meter, rundir, runner, runtime

DEPLOYED = {"name": "sandbox-one", "status": "DEPLOYED", "url": "https://sandbox-one.example"}


def api(**methods) -> mock.Mock:
    """A Baseten client with nothing behind it: every command it is asked to run completes with exit 0."""
    client = mock.Mock()
    client.create.return_value = DEPLOYED
    client.runtime.side_effect = lambda box, method, path, **_: {"status": "completed", "exitCode": 0}
    client.read.return_value = b""
    for name, value in methods.items():
        setattr(client, name, value)
    return client


def using(client):
    return mock.patch.object(runtime, "client", return_value=client)


class RuntimeTests(unittest.TestCase):
    def tearDown(self):
        runtime._SANDBOXES.clear()

    def test_the_sandbox_key_comes_from_the_environment_and_a_missing_one_says_what_to_set(self):
        with mock.patch.object(runtime, "_CLIENT", None), mock.patch.dict(runtime.os.environ, {}, clear=True):
            with self.assertRaisesRegex(runtime.RuntimeError, "BASETEN_API_KEY"):
                runtime.client()
        both = {"BASETEN_API_KEY": "model-only", "BASETEN_SANDBOX_API_KEY": "can-make-sandboxes", "BASETEN_TEAM_ID": "team-one"}
        with mock.patch.object(runtime, "_CLIENT", None), mock.patch.dict(runtime.os.environ, both, clear=True):
            client = runtime.client()
            self.assertEqual((client.key, client.team), ("can-make-sandboxes", "team-one"))
            self.assertIs(runtime.client(), client)  # one client, so one sandbox token, for every attempt
        with mock.patch.object(runtime, "_CLIENT", None), \
                mock.patch.dict(runtime.os.environ, {"BASETEN_API_KEY": "personal"}, clear=True):
            self.assertEqual((runtime.client().key, runtime.client().team), ("personal", None))

    def test_a_key_that_cannot_make_sandboxes_says_so(self):
        refused = api(manage=mock.Mock(side_effect=baseten.SandboxError("POST /v1/token failed (403): forbidden", 403)), team=None)
        with using(refused), self.assertRaisesRegex(runtime.RuntimeError, "can't create sandboxes.*service account key"):
            runtime.check_connection()
        refused.team = "team-one"  # a team the key can't reach is refused the same way: say which setting
        with using(refused), self.assertRaisesRegex(runtime.RuntimeError, r"BASETEN_TEAM_ID \(team-one\)"):
            runtime.check_connection()
        down = api(manage=mock.Mock(side_effect=baseten.SandboxError("GET /v1/sandboxes/configuration failed: timed out")))
        with using(down), self.assertRaisesRegex(runtime.RuntimeError, "Cannot reach Baseten Sandboxes"):
            runtime.check_connection()

    def test_build_sends_only_the_image_sources(self):
        client = api()
        with using(client):
            self.assertEqual(runtime.build_image("eval-image"), 0)
            name, files = client.build_image.call_args.args
            self.assertEqual((name, set(files)), ("eval-image", set(runtime.IMAGE_FILES)))
            self.assertEqual(files["Dockerfile"], (runtime.IMAGE_DIR / "Dockerfile").read_bytes())
            runtime.build_image("eval-image", "9.8.7")
            self.assertIn(b"ARG CLAUDE_CODE_VERSION=9.8.7\n", client.build_image.call_args.args[1]["Dockerfile"])
            for bad in ("sandbox/eval-image:latest", "Eval", ""):
                with self.subTest(bad), self.assertRaises(runtime.RuntimeError):
                    runtime.build_image(bad)
            with self.assertRaisesRegex(runtime.RuntimeError, "numeric release"):
                runtime.build_image("eval-image", "latest; curl x")
        failed = api(build_image=mock.Mock(side_effect=baseten.SandboxError("Image eval-image failed to build:\nstep 4")))
        with using(failed), self.assertRaisesRegex(runtime.RuntimeError, "didn't build on Baseten"):
            runtime.build_image("eval-image")

    def test_the_trial_image_carries_the_jail_and_the_relay(self):
        self.assertEqual(set(runtime.IMAGE_FILES), {"Dockerfile", "proxy.py", "jail.py"})
        dockerfile = (runtime.IMAGE_DIR / "Dockerfile").read_text()
        self.assertIn("jail.py", dockerfile)
        self.assertRegex(dockerfile, r"(?m)^USER (?!root)")  # everything in a trial runs unprivileged

    def test_an_image_name_becomes_the_reference_of_its_latest_build(self):
        self.assertEqual(runtime.resolve_image("eval-image"), "sandbox/eval-image:latest")
        self.assertEqual(runtime.resolve_image("sandbox/eval-image:abc123"), "sandbox/eval-image:abc123")
        self.assertEqual(runtime.image_name("sandbox/eval-image:latest"), "eval-image")
        self.assertEqual(runtime.image_name("eval-image"), "eval-image")

    def test_failed_or_inflight_build_is_not_an_available_image(self):
        for status, there in (("BUILT", True), ("BUILDING", False), ("FAILED", False), (None, False)):
            client = api(image_status=mock.Mock(return_value=status))
            with self.subTest(status), using(client):
                self.assertEqual(runtime.image_exists("sandbox/eval-image:latest"), there)
                client.image_status.assert_called_once_with("eval-image")

    def test_a_sandbox_is_labelled_with_its_run_and_deletes_itself(self):
        client = api()
        settings = runner.Settings(image="eval-image")
        with using(client):
            runtime.create("sandbox-one", "run-one", settings)
            self.assertEqual(client.create.call_args.args[0]["memory"], 4096)
            runtime.create("sandbox-one", "run-one", settings, 16384)
        body = client.create.call_args.args[0]
        self.assertEqual(body["memory"], 16384)
        self.assertEqual((body["name"], body["image"], body["region"]), ("sandbox-one", "sandbox/eval-image:latest", "us-pdx-1"))
        self.assertEqual(body["labels"], {"pr-eval": "run-one", "pr-eval-origin": runtime.ORIGIN})
        self.assertEqual(body["lifecycle"], {"expiration_policies": [{"type": "TTL_MAX_AGE", "value": "6h", "action": "DELETE"}]})
        for absent in ("envs", "env", "network", "ports", "volumes"):  # nothing of ours goes in, and nothing is served
            self.assertNotIn(absent, body)

    def test_root_or_open_local_api_fails_the_creation_guard(self):
        client = api()
        client.runtime.side_effect = lambda box, method, path, **_: {"status": "completed", "exitCode": 1}
        with using(client), self.assertRaisesRegex(runtime.RuntimeError, "unsafe-image .*must run non-root"):
            runtime.create("unsafe-image", "run", runner.Settings())

    def test_a_failed_creation_says_which_step_failed_but_not_what_the_api_said(self):
        with using(api(create=mock.Mock(side_effect=ValueError("response body")))), \
                self.assertRaisesRegex(runtime.RuntimeError, r"\(ValueError\)") as raised:
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertNotIn("response body", str(raised.exception))
        refused = baseten.SandboxError("POST /v1/sandboxes/instances failed (400): the whole answer", 400)
        with using(api(create=mock.Mock(side_effect=refused))), \
                self.assertRaisesRegex(runtime.RuntimeError, r"Baseten creation failed for sandbox-one \(400\)") as raised:
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertNotIn("the whole answer", str(raised.exception))
        self.assertIs(raised.exception.__cause__, refused)  # the log keeps what Baseten said
        with using(api()), mock.patch.object(runtime.time, "sleep"), \
                mock.patch.object(runtime, "execute",
                                  side_effect=runtime.RuntimeError("Baseten process transport failed (SandboxError).")), \
                self.assertRaisesRegex(runtime.RuntimeError, r"\(Baseten process transport failed \(SandboxError\)\.\)"):
            runtime.create("sandbox-one", "run", runner.Settings())

    def test_a_new_sandbox_that_cannot_take_its_first_command_yet_is_asked_again(self):
        dropped = runtime.RuntimeError("Baseten process transport failed (SandboxError).")
        with using(api()), mock.patch.object(runtime.time, "sleep") as sleep, \
                mock.patch.object(runtime, "execute", side_effect=[dropped, dropped, runtime.Execution(0, "", "")]) as run:
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertEqual(run.call_count, 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])
        with using(api()), mock.patch.object(runtime, "execute", return_value=runtime.Execution(1, "", "")) as run, \
                self.assertRaisesRegex(runtime.RuntimeError, "must run non-root"):
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertEqual(run.call_count, 1)  # a check that ran and failed is never asked again

    def test_a_full_team_waits_for_room_instead_of_losing_the_attempt(self):
        """Every run of every person shares the team's sandbox count: the eleventh sandbox waits its turn."""
        full = baseten.SandboxError("POST /v1/sandboxes/instances failed (429): Quota exceeded: 10/10 sandboxes", 429)
        client = api(create=mock.Mock(side_effect=[full, full, DEPLOYED]))
        with using(client), mock.patch.object(runtime.time, "sleep") as sleep, mock.patch("builtins.print") as said:
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertEqual((client.create.call_count, sleep.call_count), (3, 2))
        self.assertTrue(all(10 <= c.args[0] <= 20 for c in sleep.call_args_list))  # not all at once when one frees
        self.assertEqual(said.call_count, 1)  # said once, not on every try
        # A run that is stopping doesn't wait, and nor does anything but a full count.
        client = api(create=mock.Mock(side_effect=full))
        with using(client), mock.patch.object(runtime.time, "sleep") as sleep, \
                self.assertRaisesRegex(runtime.RuntimeError, r"\(429\)"):
            runtime.create("sandbox-one", "run", runner.Settings(), stopping=lambda: True)
        self.assertEqual((client.create.call_count, sleep.call_count), (1, 0))
        too_big = baseten.SandboxError("POST /v1/sandboxes/instances failed (429): You have reached the maximum memory (4096) for your account", 429)
        client = api(create=mock.Mock(side_effect=too_big))
        with using(client), mock.patch.object(runtime.time, "sleep") as sleep, self.assertRaises(runtime.RuntimeError):
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertEqual((client.create.call_count, sleep.call_count), (1, 0))
        # And it gives up after QUOTA_WAIT_SEC, so a team that stays full fails the attempt with the reason.
        client = api(create=mock.Mock(side_effect=full))
        with using(client), mock.patch.object(runtime.time, "sleep"), mock.patch("builtins.print"), \
                mock.patch.object(runtime.random, "uniform", return_value=15), self.assertRaises(runtime.RuntimeError):
            runtime.create("sandbox-one", "run", runner.Settings())
        self.assertEqual(client.create.call_count, runtime.QUOTA_WAIT_SEC // 15 + 1)

    def test_a_dropped_transfer_is_tried_once_more(self):
        client = api(upload=mock.Mock(side_effect=[ConnectionResetError(), None]))
        with tempfile.TemporaryDirectory() as d, using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), \
                mock.patch.object(runtime.time, "sleep"):
            (Path(d) / "f").write_bytes(b"x")
            runtime.upload("sb", Path(d) / "f", "/tmp/f")
            self.assertEqual(client.upload.call_count, 2)
            client.upload.side_effect = ConnectionResetError()
            with self.assertRaisesRegex(runtime.RuntimeError, r"Could not upload f \(ConnectionResetError\)"):
                runtime.upload("sb", Path(d) / "f", "/tmp/f")
            client.download.return_value = False  # the sandbox has no such file
            runtime.download("sb", "/logs/proxy.log", Path(d) / "p", optional=True)
            self.assertEqual(client.download.call_count, 1)  # an optional file may simply not exist
            with self.assertRaisesRegex(runtime.RuntimeError, "Could not download"):
                runtime.download("sb", "/workspace/.git/pr-eval.patch", Path(d) / "p")
            self.assertEqual(client.download.call_count, 3)

    def test_a_folder_goes_up_as_one_archive_and_is_unpacked_there(self):
        sent = {}
        def upload(box, local, remote):
            sent[remote] = subprocess.run(["tar", "-tf", str(local)], capture_output=True, text=True).stdout.split()
        client = api(upload=mock.Mock(side_effect=upload))
        with tempfile.TemporaryDirectory() as d, using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), \
                mock.patch.object(runtime, "execute", return_value=runtime.Execution(0, "", "")) as run:
            (Path(d) / "tests").mkdir()
            (Path(d) / "tests" / "test.sh").write_text("pytest\n")
            runtime.upload("sb", Path(d) / "tests", "/tests")
            (target, names), = sent.items()
            self.assertIn("./test.sh", names)
            self.assertEqual(run.call_args.args[1], f"mkdir -p /tests && tar -xf {target} -C /tests && rm {target}")
            with mock.patch.object(runtime, "execute", return_value=runtime.Execution(2, "", "")), \
                    self.assertRaisesRegex(runtime.RuntimeError, "Could not unpack"):
                runtime.upload("sb", Path(d) / "tests", "/tests")

    def test_process_transport_never_embeds_secret_values_in_command(self):
        client = api(read=mock.Mock(side_effect=[b"hello", b""]))
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED):
            result = runtime.execute("sb", "printf hello", timeout=10, env={"TEST_KEY": "secret-value"})
            with self.assertRaisesRegex(runtime.RuntimeError, "Invalid environment variable name"):
                runtime.execute("sb", "true", timeout=10, env={"A=b; curl x": "1"})
        (_, method, path), body = client.runtime.call_args_list[0].args, client.runtime.call_args_list[0].kwargs["body"]
        self.assertEqual((method, path), ("POST", "/process"))
        self.assertIn('TEST_KEY="${TEST_KEY}"', body["command"])
        self.assertNotIn("secret-value", body["command"])
        self.assertEqual(body["env"], {"TEST_KEY": "secret-value"})
        self.assertIn("mkdir -p /logs/home && env -i ", body["command"])
        self.assertIn("HOME=/logs/home", body["command"])
        self.assertEqual((body["keepAlive"], body["waitForCompletion"], body["timeout"]), (True, False, 10))
        self.assertEqual((result.code, result.stdout, result.timed_out), (0, "hello", False))

    def test_a_command_gets_the_toolchains_and_what_it_is_given_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as d:
            out, err = str(Path(d) / "out"), str(Path(d) / "err")
            command = runtime.wrapped("env", {"GIVEN": "1"}, out, err).replace("/logs", str(Path(d) / "logs"))
            around = {"PATH": os.environ["PATH"], "GOPATH": "/go", "GIVEN": "1", "BASETEN_API_KEY": "the sandbox's own",
                      "SOME_TOKEN": "x", "HOME": "/home/agent"}
            subprocess.run(["bash", "-c", command], env=around, check=True)
            seen = dict(line.split("=", 1) for line in Path(out).read_text().splitlines() if "=" in line)
        self.assertEqual((seen["GIVEN"], seen["GOPATH"], seen["CI"]), ("1", "/go", "1"))
        self.assertEqual(seen["HOME"], str(Path(d) / "logs" / "home"))
        self.assertFalse({"BASETEN_API_KEY", "SOME_TOKEN"} & set(seen))

    def test_the_sandbox_keeps_the_time_so_a_stalled_watcher_never_takes_a_time_limit_for_a_crash(self):
        """The sandbox ends a command at its limit by its own clock. The machine watching may have slept or been
        paused meanwhile (a laptop; the hosted page's sandbox on standby): by its clock the limit isn't up yet."""
        states, calls = iter([{"status": "running"}, {"status": "killed", "exitCode": -1}]), []

        def call(box, method, path, **kwargs):
            calls.append((method, path.rsplit("/", 1)[-1], (kwargs.get("body") or {}).get("timeout")))
            return next(states) if method == "GET" else {}
        client = api(read=mock.Mock(side_effect=[b"partial", b""]))
        client.runtime.side_effect = call
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), mock.patch.object(runtime.time, "sleep"):
            result = runtime.execute("sb", "claude -p", timeout=1800)
        self.assertEqual([(method, limit) for method, _, limit in calls], [("POST", 1800), ("GET", None), ("GET", None)])
        client.exec.assert_called_once()  # ended before it kept the end of its output: kept now
        self.assertEqual((result.timed_out, result.code, result.stdout), (True, -1, "partial"))
        # A command that died some other way is not a time limit.
        client = api()
        client.runtime.side_effect = lambda box, method, path, **_: {"status": "failed", "exitCode": -1}
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED):
            result = runtime.execute("sb", "claude -p", timeout=1800)
        self.assertEqual((result.timed_out, result.code), (False, -1))

    def test_a_command_the_sandbox_did_not_end_at_its_limit_is_killed_from_here(self):
        states, calls = iter([{"status": "running"}, {"status": "killed", "exitCode": -1}]), []

        def call(box, method, path, **_):
            calls.append((method, path.rsplit("/", 1)[-1]))
            return next(states) if method == "GET" else {}
        client = api(read=mock.Mock(side_effect=[b"partial", b""]))
        client.runtime.side_effect = call
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED):
            result = runtime.execute("sb", "sleep 20", timeout=-1 - runtime.KILL_GRACE_SEC)
        self.assertEqual([method for method, _ in calls], ["POST", "GET", "DELETE", "GET"])
        self.assertEqual(calls[2][1], "kill")
        self.assertEqual((result.timed_out, result.code, result.stdout), (True, -1, "partial"))

    def test_a_timed_out_command_that_never_ends_is_a_sandbox_error(self):
        client = api()
        client.runtime.side_effect = lambda box, method, path, **_: {"status": "running"}
        clock = iter(range(0, 10_000, 45))
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), \
                mock.patch.object(runtime.time, "monotonic", side_effect=lambda: next(clock)), \
                mock.patch.object(runtime.time, "sleep"), \
                self.assertRaisesRegex(runtime.RuntimeError, "didn't confirm that a timed-out command ended"):
            runtime.execute("sb", "sleep 20", timeout=10)

    def test_a_sandbox_that_lost_its_command_says_what_it_knows_and_is_worth_another_sandbox(self):
        """A sandbox that answers and no longer knows a command it was running lost it, with the relay and
        everything else: nothing more can come of that sandbox, and another one could go differently."""
        def call(box, method, path, **_):
            if method == "GET":
                raise baseten.SandboxError('GET /process/eval-1 failed (404): {"error":"process not found"}', 404)
            return {}
        client = api(exec=mock.Mock(return_value=(0, "up since 2026-11-12 00:02:05, commands since Thu Nov 12 00:18:07 2026\nMem: 16014 5937\n", "")))
        client.runtime.side_effect = call
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED):
            with self.assertRaisesRegex(runtime.RuntimeError, r"^The sandbox lost the command it was running: up since "
                                                              r"2026-11-12 00:02:05, commands since .* Mem: 16014 5937$") as lost:
                runtime.execute("sb", "claude -p", timeout=1800)
            self.assertTrue(causes.transient(lost.exception))
            self.assertEqual(causes.describe(lost.exception, "agent"),
                             "The agent's run in its sandbox broke off (the sandbox lost the command).")
            client.exec.side_effect = baseten.SandboxError("POST /process failed (502): gone", 502)  # no answer at all now
            with self.assertRaisesRegex(runtime.RuntimeError, r"^The sandbox lost the command it was running\.$") as lost:
                runtime.execute("sb", "claude -p", timeout=1800)
            self.assertTrue(causes.transient(lost.exception))
        # Any other refusal is still a refusal: asking again would be refused again.
        client = api()
        client.runtime.side_effect = baseten.SandboxError("POST /process failed (400): bad command", 400)
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), \
                self.assertRaisesRegex(runtime.RuntimeError, "process transport failed") as refused:
            runtime.execute("sb", "true", timeout=10)
        self.assertFalse(causes.transient(refused.exception))

    def test_a_dropped_command_is_a_sandbox_error_that_names_no_response(self):
        client = api()
        client.runtime.side_effect = baseten.SandboxError("POST /process failed (502): the whole answer", 502)
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED), \
                self.assertRaisesRegex(runtime.RuntimeError, r"^Baseten process transport failed \(SandboxError\)\.$"):
            runtime.execute("sb", "true", timeout=10)

    def test_a_background_process_gets_its_secret_through_the_environment_and_stopping_it_never_fails(self):
        client, secret = api(), {"PROXY_UPSTREAM_HEADERS": '{"X-Api-Key": "real-key"}'}
        with using(client), mock.patch.object(runtime, "get", return_value=DEPLOYED):
            runtime.start("sb", "model-relay", "exec python3 /opt/eval/proxy.py", env=secret, timeout=1920)
            body = client.runtime.call_args.kwargs["body"]
            self.assertEqual((body["name"], body["timeout"], body["waitForCompletion"]), ("model-relay", 1920, False))
            self.assertEqual(body["env"], secret)
            self.assertNotIn("real-key", body["command"])
            # The shell that starts it becomes it: no parent is left with the secret in its environment.
            self.assertTrue(body["command"].startswith("mkdir -p /logs/home && exec env -i "))
            self.assertTrue(body["command"].endswith(" >/dev/null 2>&1"))
            runtime.stop("sb", "model-relay")
            self.assertEqual(client.runtime.call_args.args[1:], ("DELETE", "/process/model-relay/kill"))
            client.runtime.side_effect = baseten.SandboxError("DELETE failed (502)", 502)
            runtime.stop("sb", "model-relay")  # the sandbox is going away: so is the process
        with using(client), mock.patch.object(runtime, "get", side_effect=runtime.RuntimeError("There is no running sandbox sb.")):
            runtime.stop("sb", "model-relay")

    def test_delete_waits_until_baseten_says_the_sandbox_is_going(self):
        client = api(get=mock.Mock(side_effect=[{"status": "DEPLOYED"}, {"status": "DELETING"}]))
        runtime._SANDBOXES["sb"] = DEPLOYED
        with using(client), mock.patch.object(runtime.time, "sleep"):
            runtime.delete("sb")
        client.delete.assert_called_once_with("sb")
        self.assertEqual(client.get.call_count, 2)
        self.assertNotIn("sb", runtime._SANDBOXES)
        with using(api(get=mock.Mock(return_value=None))):
            runtime.delete("already-gone")
        stuck = api(delete=mock.Mock(side_effect=baseten.SandboxError("DELETE failed (500): the whole answer", 500)))
        with using(stuck), self.assertRaisesRegex(runtime.RuntimeError, r"^Could not delete sb \(SandboxError\)\.$"):
            runtime.delete("sb")

    def test_cleanup_touches_only_this_machines_sandboxes_of_the_run(self):
        """A team's sandboxes are shared: the hosted page's, other people's runs and other tools' are in the list."""
        def box(name, run=None, origin=runtime.ORIGIN, status="DEPLOYED", **labels):
            labels |= {"pr-eval": run, "pr-eval-origin": origin} if run else {}
            return {"name": name, "status": status, "labels": labels or None}
        everything = [
            box("a", "run"), box("b", "run"), box("failed-to-start", "run", status="FAILED"),
            box("going", "run", status="DELETING"), box("gone", "run", status="TERMINATED"),
            box("another-run", "run-two"),
            box("same-run-id-on-another-machine", "run", origin="someone-else"),
            {"name": "unmarked-origin", "status": "DEPLOYED", "labels": {"pr-eval": "run"}},
            box("pr-eval-host", app="pr-eval-host"), box("another-tool", app="another-tool"), box("no-labels")]
        deleted = []

        def delete(name):
            if name == "a":
                raise runtime.RuntimeError("stuck")
            deleted.append(name)
        with using(api(list=mock.Mock(return_value=everything))), mock.patch.object(runtime, "delete", side_effect=delete):
            self.assertEqual(runtime.trial_sandboxes(), {"run": ["a", "b", "failed-to-start"], "run-two": ["another-run"]})
            with self.assertRaisesRegex(runtime.RuntimeError, "Could not delete a;"):
                runtime.cleanup("run")
            self.assertEqual(deleted, ["b", "failed-to-start"])  # one stuck delete doesn't leave the rest up
            self.assertEqual(runtime.cleanup("a-run-with-none"), [])
        self.assertEqual(deleted, ["b", "failed-to-start"])
        with using(api(list=mock.Mock(side_effect=baseten.SandboxError("GET failed (500)", 500)))), \
                self.assertRaisesRegex(runtime.RuntimeError, "Could not list sandboxes"):
            runtime.cleanup("run")

    def test_validation_cache_is_bound_to_image_and_region(self):
        with tempfile.TemporaryDirectory() as d:
            task = SimpleNamespace(path=Path(d))
            (task.path / "validation").mkdir()
            settings = runner.Settings(image="sandbox/image:one")
            record = {"status": "valid", **runner.environment_identity(settings)}
            (task.path / "validation/result.json").write_text(json.dumps(record))
            self.assertEqual(runner.validation_status(task, settings), "valid")
            settings.image = "sandbox/image:two"
            self.assertIsNone(runner.validation_status(task, settings))
            settings.image, settings.region = "sandbox/image:one", "eu-west-1"
            self.assertIsNone(runner.validation_status(task, settings))

    def test_proxy_rate_limit_waits_count_as_retry_waits(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "proxy.log"
            log.write_text("turn=1 /v1/messages shape=anthropic effort=high -> 200 in 3.0s out=10\n"
                           "rate-limited: waited 12.5s over 3 retries, then 200\n"
                           "rate-limited: waited 2.0s over 1 retries, then 200\n")
            agent = runner.add_proxy_waits({"api_retries": 1, "rate_limited_retries": 1, "retry_wait_seconds": 0.5}, log)
        self.assertEqual((agent["api_retries"], agent["rate_limited_retries"], agent["retry_wait_seconds"]), (5, 5, 15.0))

    def test_failed_patch_capture_is_not_a_model_failure(self):
        with mock.patch.object(runner, "sh", return_value=(1, "git failed", False)):
            with self.assertRaises(runtime.RuntimeError):
                runner.capture_patch("sb", "a" * 40, Path("unused.patch"))

    def test_a_stop_during_creation_still_deletes_the_new_sandbox(self):
        def create(*_, **__):
            runner.STOPPING.set()  # the stop lands while the sandbox is being allocated
        try:
            with mock.patch.object(runtime, "create", side_effect=create) as made:
                with self.assertRaises(runtime.RuntimeError):
                    runner.start_container("sb", "run", runner.Settings())
                self.assertIs(made.call_args.kwargs["stopping"](), True)  # and a full team is not waited for
                with self.assertRaisesRegex(runtime.RuntimeError, "no new sandbox"):
                    runner.start_container("sb", "run", runner.Settings())
                self.assertEqual(made.call_count, 1)
        finally:
            runner.STOPPING.clear()

    def test_a_failed_delete_still_records_the_check(self):
        with tempfile.TemporaryDirectory() as d:
            task = SimpleNamespace(id="public-task", path=Path(d), meta={"environment": {}})
            with mock.patch.object(runner, "start_container"), \
                    mock.patch.object(runner, "prepare_workspace", return_value=("setup-error", {})), \
                    mock.patch.object(runtime, "delete", side_effect=runtime.RuntimeError("slow delete")):
                record = runner.validate_task(task, runner.Settings())
            self.assertEqual(record["status"], "setup-error")
            self.assertEqual(json.loads((Path(d) / "validation" / "result.json").read_text())["status"], "setup-error")


class ClientTests(unittest.TestCase):
    """The Baseten client's own transfers, against a sandbox that only records what it is sent."""

    @staticmethod
    def part_bytes(body: bytes) -> bytes:
        head, _, rest = body.partition(b"\r\n\r\n")
        boundary = head.split(b"\r\n", 1)[0]
        return rest[:-len(b"\r\n" + boundary + b"--\r\n")]

    def test_a_large_file_uploads_in_parts_read_from_disk_without_mmap(self):
        # A task's ~200 MB source, uploaded by an attempt per model at once: read whole, 20 copies
        # filled the hosted 8 GB; memory-mapped, every upload failed on the hosted volume
        # (virtiofs: OSError 19, "No such device").
        client, sent, completed = baseten.Client("key"), {}, []

        def call(box, method, path, **kwargs):
            if "/initiate/" in path:
                self.assertEqual((method, path), ("POST", "/filesystem-multipart/initiate/%2Ftmp%2Fsource.tar.gz"))
                return {"uploadId": "u1"}
            if "/part?" in path:
                number = int(path.rsplit("=", 1)[1])
                sent[number] = self.part_bytes(kwargs["data"])
                return {"etag": f"e{number}"}
            self.assertEqual((method, path), ("POST", "/filesystem-multipart/u1/complete"))
            completed.append(kwargs["body"])
            return {}
        real_read_bytes = Path.read_bytes

        def read_bytes(path):
            if path.stat().st_size > baseten.UPLOAD_PART:
                raise AssertionError("a large upload was read whole")
            return real_read_bytes(path)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(client, "runtime", side_effect=call), \
                mock.patch("mmap.mmap", side_effect=OSError(19, "No such device")), \
                mock.patch.object(Path, "read_bytes", read_bytes):
            source = Path(d) / "source.tar.gz"
            source.write_bytes(os.urandom(12 * 1024 * 1024 + 7))
            client.upload(DEPLOYED, source, "/tmp/source.tar.gz")
            self.assertEqual(b"".join(sent[n] for n in sorted(sent)), real_read_bytes(source))
        self.assertEqual([len(sent[n]) for n in sorted(sent)], [5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024 + 7])
        self.assertEqual(completed, [{"parts": [{"partNumber": n, "etag": f"e{n}"} for n in (1, 2, 3)]}])

    def test_a_failed_part_abandons_the_upload_instead_of_completing_half_a_file(self):
        client, calls = baseten.Client("key"), []

        def call(box, method, path, **kwargs):
            calls.append((method, path.split("?")[0]))
            if "/initiate/" in path:
                return {"uploadId": "u1"}
            if "/part?" in path:
                raise baseten.SandboxError("PUT part failed (500)", 500)
            return {}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(client, "runtime", side_effect=call):
            (Path(d) / "big").write_bytes(b"x" * (baseten.UPLOAD_PART + 1))
            with self.assertRaises(baseten.SandboxError):
                client.upload(DEPLOYED, Path(d) / "big", "/tmp/big")
        self.assertIn(("DELETE", "/filesystem-multipart/u1/abort"), calls)
        self.assertNotIn(("POST", "/filesystem-multipart/u1/complete"), calls)

    def test_a_small_or_empty_file_uploads_whole(self):
        client = baseten.Client("key")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(client, "write") as write, \
                mock.patch.object(client, "runtime") as parts:
            (Path(d) / "prompt.md").write_bytes(b"head" + b"x" * 100)
            (Path(d) / "empty").write_bytes(b"")
            client.upload(DEPLOYED, Path(d) / "prompt.md", "/tmp/instruction.md")
            client.upload(DEPLOYED, Path(d) / "empty", "/tmp/empty")
        self.assertEqual([c.args[1:3] for c in write.call_args_list],
                         [("/tmp/instruction.md", b"head" + b"x" * 100), ("/tmp/empty", b"")])
        parts.assert_not_called()

    def test_attempts_starting_at_once_share_one_sandbox_token(self):
        client, minted = baseten.Client("key", "team-one"), []

        def send(url, method="GET", **kwargs):
            minted.append((url, kwargs["auth"]))
            threading.Event().wait(0.05)
            return {"token": "sandbox-token", "expires_at": "2999-01-01T00:00:00Z"}
        with mock.patch.object(client, "_send", side_effect=send):
            tokens = []
            threads = [threading.Thread(target=lambda: tokens.append(client.token())) for _ in range(8)]
            [t.start() for t in threads]
            [t.join(5) for t in threads]
        self.assertEqual(minted, [("https://api.baseten.co/v1/token", "key")])
        self.assertEqual(tokens, ["sandbox-token"] * 8)


class ModelKeyTests(unittest.TestCase):
    """The agent never holds the company's model key, and no artifact does: only the attempt's model relay."""

    def test_the_agent_gets_a_placeholder_and_only_the_relay_gets_the_key(self):
        key = "real-company-key-0123456789abcdef"
        for provider, name, upstream, header in (
                ("anthropic", "ANTHROPIC_API_KEY", "https://api.anthropic.com", "X-Api-Key"),
                ("baseten", "BASETEN_API_KEY", "https://inference.baseten.co/v1", "Authorization")):
            with self.subTest(provider), tempfile.TemporaryDirectory() as d:
                d = Path(d)
                task = SimpleNamespace(id="public-task", instruction="Fix it.", path=d,
                                       meta={"task": {"repo": "public/example"}, "agent": {}, "environment": {}})
                model = SimpleNamespace(key="m", model="m", effort="high", provider=provider)
                ran, started, order = [], [], []

                def execute(container, script, *, env=None, **_):
                    ran.append((container, script, env or {}))
                    order.append("agent" if "claude -p" in script else "step")
                    # An agent that found a key and printed it, in its log and its change.
                    return runtime.Execution(0, json.dumps({"type": "result", "result": key}) + "\n", key)

                def start(container, process, script, *, env=None, **_):
                    started.append((container, process, script, env or {}))
                    order.append("relay up")

                def download(container, remote, local, optional=False):
                    local.write_text(f"+leaked = {key!r}\n")
                with mock.patch.dict(os.environ, {name: key}, clear=True), \
                        mock.patch.object(runner, "container_name", side_effect=["agent", "verifier"]), \
                        mock.patch.object(runner, "start_container"), \
                        mock.patch.object(runner, "prepare_workspace", return_value=(None, {"baseline": "a" * 40})), \
                        mock.patch.object(runtime, "start", side_effect=start), \
                        mock.patch.object(runtime, "stop", side_effect=lambda *_: order.append("relay down")), \
                        mock.patch.object(runtime, "execute", side_effect=execute), \
                        mock.patch.object(runtime, "upload"), mock.patch.object(runtime, "delete"), \
                        mock.patch.object(runtime, "download", side_effect=download), \
                        mock.patch.object(runner, "price_agent", side_effect=lambda agent, *args: agent), \
                        mock.patch.object(runner, "run_tests", return_value={"passed": True, "timed_out": False,
                                                                              "output": "ok"}):
                    runner.run_trial(task, model, 1, d / "trial", "run-one", runner.Settings())
                # The agent: a placeholder to sign in with, in a jail with no network but the bridge to the relay.
                (container, script, env), = [r for r in ran if "claude -p" in r[1]]
                self.assertEqual(container, "agent")
                self.assertTrue(env[name].startswith("pr-eval-placeholder-"))
                self.assertIn(f"--net none --bridge {runner.PROXY_PORT}={runner.RELAY_SOCKET} -- claude -p", script)
                self.assertFalse([r for r in ran if key in r[1] + json.dumps(r[2])])  # in no command, in no environment
                # The relay: the key's one holder, through its environment, outside the jail.
                (container, process, relay, env), = started
                self.assertEqual((container, process), ("agent", runner.RELAY))
                self.assertEqual(json.loads(env["PROXY_UPSTREAM_HEADERS"]),
                                 {header: ("Bearer " if header == "Authorization" else "") + key})
                self.assertIn(f"--upstream {upstream} ", relay)
                self.assertNotIn(key, relay)
                self.assertNotIn("jail.py", relay)
                # And it is gone, with the key, as soon as the agent stops: before any other step in the sandbox.
                self.assertEqual(order[order.index("relay up"):][:3], ["relay up", "agent", "relay down"])
                for path in (d / "trial").rglob("*"):
                    if path.is_file():
                        self.assertNotIn(key, path.read_text(errors="replace"), path.name)

    def test_the_relay_is_stopped_whatever_becomes_of_the_agent(self):
        model = SimpleNamespace(key="m", model="m", effort="high", provider="anthropic")
        run = lambda d: runner.run_agent("agent", model, {"ANTHROPIC_API_KEY": "placeholder"}, {"X-Api-Key": "real"},  # noqa: E731
                                         Path(d) / "agent.jsonl", 60)
        dropped = runtime.RuntimeError("Baseten process transport failed (SandboxError).")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(runtime, "start"), \
                mock.patch.object(runtime, "stop") as stop, mock.patch.object(runtime, "execute", side_effect=dropped):
            with self.assertRaises(runtime.RuntimeError):
                run(d)
        stop.assert_called_once_with("agent", runner.RELAY)
        # An agent that couldn't be jailed, or had no relay, never ran: the attempt is lost, not failed.
        for code, stderr in ((runner.RELAY_MISSING, "pr-eval: the model relay did not start"),
                             (1, "pr-eval jail: no namespaces of its own for the command: Operation not permitted")):
            with self.subTest(stderr), tempfile.TemporaryDirectory() as d, mock.patch.object(runtime, "start"), \
                    mock.patch.object(runtime, "stop"), mock.patch.object(runtime, "download") as download, \
                    mock.patch.object(runtime, "execute", return_value=runtime.Execution(code, "", stderr)):
                with self.assertRaises(runner.StepFailed) as failed:
                    run(d)
                self.assertEqual(failed.exception.step, "network")
                download.assert_not_called()


class TrialBoundaryTests(unittest.TestCase):
    def trial(self, d, events, prepare, on_delete=lambda name: None, agent=None, trial_dir=None):
        """run_trial with every sandbox step mocked; the agent's sandbox is "agent", the verifier "verifier"."""
        task = SimpleNamespace(id="public-task", instruction="Fix the public example.",
                               meta={"task": {"repo": "public/example"}, "agent": {}, "environment": {}}, path=d)
        model = SimpleNamespace(key="model", model="model", provider="anthropic", prices={"model": {"input": 1, "output": 1}})

        def finished(name, model, placeholder_env, relay_headers, path, timeout, *_):
            path.write_text("")
            events.append(("agent", name))
            return {"subtype": "success", "timed_out": False}

        def tests(name, *_):
            events.append(("hidden", name))
            return {"passed": True, "timed_out": False, "output": "ok"}
        with mock.patch.object(runner, "container_name", side_effect=["agent", "verifier"]), \
                mock.patch.object(runner, "credential_env", return_value={"ANTHROPIC_API_KEY": "real"}), \
                mock.patch.object(runner, "start_container", side_effect=lambda name, *_: events.append(("create", name))), \
                mock.patch.object(runner, "prepare_workspace", side_effect=prepare), \
                mock.patch.object(runtime, "upload", side_effect=lambda name, *_: events.append(("upload", name))), \
                mock.patch.object(runtime, "download"), \
                mock.patch.object(runtime, "delete", side_effect=lambda name: (events.append(("delete", name)), on_delete(name))), \
                mock.patch.object(runner, "run_agent", side_effect=agent or finished), \
                mock.patch.object(runner, "price_agent", side_effect=lambda agent, *args: agent), \
                mock.patch.object(runner, "capture_patch", return_value=("patch", "1\t0\tfile.py")), \
                mock.patch.object(runner, "sh", return_value=(0, "", False)), \
                mock.patch.object(runner, "set_aside_agent_tests", return_value=[]), \
                mock.patch.object(runner, "run_tests", side_effect=tests):
            return runner.run_trial(task, model, 1, trial_dir or d / "trial", "run-one", runner.Settings())

    def test_the_answer_reaches_the_verifier_only_after_the_agent_vm_is_deleted(self):
        events, both_set_up = [], threading.Barrier(2, timeout=5)

        def prepare(name, *_):
            events.append(("prepare", name))
            both_set_up.wait()  # the verifier is set up while the agent's sandbox is
            return None, {"baseline": "a" * 40}
        with tempfile.TemporaryDirectory() as d:
            result = self.trial(Path(d), events, prepare)
        gone = events.index(("delete", "agent"))
        self.assertLess(events.index(("prepare", "verifier")), events.index(("agent", "agent")))
        self.assertEqual(events[gone + 1:], [("upload", "verifier"), ("hidden", "verifier"), ("delete", "verifier")])
        self.assertEqual(result["outcome"], "solved")

    def test_an_attempt_whose_agent_ran_is_charged_even_when_it_ends_with_no_cost(self):
        """The spending limits read the run's ledger: an agent cut off by a sandbox error still spent."""
        def lost(*_):
            raise runtime.RuntimeError("sandbox went away")
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "trials" / "t1").mkdir(parents=True)
            result = self.trial(Path(d), [], lambda *_: (None, {"baseline": "a" * 40}), agent=lost,
                                trial_dir=Path(d) / "trials" / "t1")
            charges = [json.loads(line) for line in (Path(d) / rundir.SPEND_LEDGER).read_text().splitlines()]
        self.assertEqual(result["invalid_reason"], "sandbox-error")
        self.assertEqual([(c["kind"], c["model"], c["usd"]) for c in charges], [("agent", "model", None)])

    def test_a_metered_attempt_reaches_only_the_meter_and_leaves_its_charges_to_it(self):
        """Hosted: the attempt's relay calls the meter with the attempt's ticket, never a provider with the key;
        the ticket is revoked once the agent stops, and the run's ledger gets no second, whole-attempt charge."""
        events, seen = [], {}

        def agent(name, model, placeholder_env, relay_headers, path, timeout, meter_url):
            seen.update(placeholder_env=placeholder_env, relay_headers=relay_headers, meter_url=meter_url,
                        tickets=list((path.parents[2] / "meter").iterdir()))
            path.write_text("")
            return {"subtype": "success", "timed_out": False, "cost_usd": 3.0}
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"PR_EVAL_METER_URL": "https://m.example/"}):
            trial_dir = Path(d) / "trials" / "t1"
            trial_dir.mkdir(parents=True)
            result = self.trial(Path(d), events, lambda *_: (None, {"baseline": "a" * 40}), agent=agent, trial_dir=trial_dir)
            left = list((Path(d) / "meter").iterdir())
            ledger = (Path(d) / rundir.SPEND_LEDGER).is_file()
        self.assertEqual(list(seen["relay_headers"]), [meter.HEADER])
        self.assertTrue(seen["relay_headers"][meter.HEADER].startswith(Path(d).name + "."))
        self.assertTrue(seen["placeholder_env"]["ANTHROPIC_API_KEY"].startswith("pr-eval-placeholder-"))
        self.assertNotIn("real", json.dumps(seen["relay_headers"]) + json.dumps(seen["placeholder_env"]))  # the key stays on the page
        self.assertEqual((seen["meter_url"], len(seen["tickets"]), left), ("https://m.example", 1, []))
        self.assertFalse(ledger)
        self.assertEqual(result["outcome"], "solved")

    def test_an_attempt_that_ends_early_deletes_the_verifier_mid_setup(self):
        events, deleted, finished = [], threading.Event(), threading.Event()

        def prepare(name, *_):
            if name == "agent":
                return "setup-error", {}
            deleted.wait(5)  # a long setup, cut short by the deletion
            events.append(("setup ended", name))
            finished.set()
            return None, {"baseline": "a" * 40}
        with tempfile.TemporaryDirectory() as d:
            result = self.trial(Path(d), events, prepare, on_delete=lambda name: deleted.set())
            finished.wait(5)
        self.assertEqual(result["invalid_reason"], "setup-error")
        self.assertLess(events.index(("delete", "verifier")), events.index(("setup ended", "verifier")))
        self.assertNotIn(("upload", "verifier"), events)

    def test_a_rerun_starts_in_a_clean_folder_and_says_what_it_replaces(self):
        with tempfile.TemporaryDirectory() as d:
            earlier = Path(d) / "trial"
            earlier.mkdir()
            (earlier / "result.json").write_text(json.dumps({"outcome": "invalid", "invalid_reason": "sandbox-error"}))
            (earlier / "error.log").write_text("Baseten creation failed")
            result = self.trial(Path(d), [], lambda name, *_: (None, {"baseline": "a" * 40}))
            self.assertFalse((earlier / "error.log").exists())
        self.assertEqual((result["outcome"], result["rerun_after"]), ("solved", "sandbox-error"))


if __name__ == "__main__":
    unittest.main()
