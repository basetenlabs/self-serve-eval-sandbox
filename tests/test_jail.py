"""The jail every step of a trial runs in (docker/jail.py). Its namespaces need Linux, so off Linux only
its command line is tested here; hosted/README.md says how the rest is proven in a real sandbox."""
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

JAIL = [sys.executable, str(Path(__file__).parents[1] / "docker" / "jail.py")]


def jail(*args: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run([*JAIL, *args], capture_output=True, text=True, timeout=60, **kwargs)


def can_jail() -> bool:
    """Whether this machine lets an unprivileged user make namespaces (not macOS, not every CI runner)."""
    return sys.platform == "linux" and jail("--net", "none", "--", "true").returncode == 0


class CommandLineTests(unittest.TestCase):
    def test_a_bridge_is_only_for_a_jail_without_a_network(self):
        for args in (["--net", "host", "--bridge", "18787=/tmp/relay.sock", "--", "true"], ["--net", "none"],
                     ["--", "true"], ["--net", "everything", "--", "true"]):
            with self.subTest(args=args):
                result = jail(*args)
                self.assertEqual(result.returncode, 2)

    @unittest.skipIf(sys.platform == "linux", "Linux can make the jail")
    def test_a_machine_that_cannot_make_the_jail_never_runs_the_command_unjailed(self):
        with tempfile.TemporaryDirectory() as d:
            result = jail("--net", "none", "--", "touch", str(Path(d) / "ran"))
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(d) / "ran").exists())


@unittest.skipUnless(can_jail(), "needs Linux with unprivileged user namespaces")
class JailTests(unittest.TestCase):
    def test_the_commands_status_and_output_come_back(self):
        result = jail("--net", "none", "--", "bash", "-c", "echo out; echo err >&2; exit 7")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (7, "out\n", "err\n"))
        self.assertEqual(jail("--net", "none", "--", "no-such-command").returncode, 127)

    def test_without_a_network_there_is_only_loopback(self):
        probe = ("import socket\n"
                 "for host in ('1.1.1.1', '140.82.112.3'):\n"
                 "    s = socket.socket(); s.settimeout(3)\n"
                 "    print(host, s.connect_ex((host, 443)) != 0)\n"
                 "try:\n    socket.getaddrinfo('github.com', 443); print('dns', False)\n"
                 "except OSError:\n    print('dns', True)\n"
                 "print(sorted(name for _, name in socket.if_nameindex()))\n")
        result = jail("--net", "none", "--", sys.executable, "-c", probe)
        self.assertEqual(result.stdout.split("\n")[:4], ["1.1.1.1 True", "140.82.112.3 True", "dns True", "['lo']"], result.stderr)

    def test_the_bridge_is_the_one_way_out_and_leads_only_to_its_socket(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            path = str(Path(d) / "relay.sock")
            server = socket.socket(socket.AF_UNIX)
            server.bind(path)
            server.listen(1)

            def answer():
                conn, _ = server.accept()
                conn.sendall(b"from the relay: " + conn.recv(100))
                conn.close()
            threading.Thread(target=answer, daemon=True).start()
            ask = ("import socket; s = socket.create_connection(('127.0.0.1', 18787), 5); s.sendall(b'hello'); "
                   "s.shutdown(socket.SHUT_WR); print(s.recv(100).decode())")
            result = jail("--net", "none", "--bridge", f"18787={path}", "--", sys.executable, "-c", ask)
            server.close()
        self.assertEqual(result.stdout.strip(), "from the relay: hello", result.stderr)

    def test_it_sees_no_process_outside_and_holds_no_privilege(self):
        result = jail("--net", "none", "--", "bash", "-c",
                      "ls /proc | grep -c '^[0-9]' ; grep CapEff /proc/self/status; id -u; cat /proc/1/environ | tr '\\0' '\\n' | grep -c SECRET_OUTSIDE",
                      env={**os.environ, "SECRET_OUTSIDE": "1"})
        lines = result.stdout.split()
        self.assertLessEqual(int(lines[0]), 6)  # the jail's own few, none of the machine's
        self.assertEqual(lines[1:3], ["CapEff:", "0000000000000000"])
        self.assertEqual(lines[3], str(os.getuid()))

    def test_nothing_the_command_started_outlives_it(self):
        with tempfile.TemporaryDirectory() as d:
            mark = Path(d) / "still-running"
            jail("--net", "host", "--", "bash", "-c", f"(sleep 2; touch {mark}) & disown; exit 0")
            threading.Event().wait(3)
            self.assertFalse(mark.exists())


if __name__ == "__main__":
    unittest.main()
