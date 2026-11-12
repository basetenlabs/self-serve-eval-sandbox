"""Run a command where it can't reach the network, or can't leave anything running: a jail made of Linux namespaces.

    jail.py --net none -- bash /tests/test.sh
    jail.py --net none --bridge 18787=/logs/relay.sock -- claude -p ...
    jail.py --net host -- bash -c "$SETUP"

Baseten Sandboxes can't limit a sandbox's network yet, so a trial does it from inside, as the image's
unprivileged user:

- `--net none`: a network namespace with only loopback. No interface leads out, there is no DNS, and the
  sandbox's own API is out of reach too. `--bridge PORT=SOCKET` adds the one way out: connections to
  127.0.0.1:PORT inside are carried to the Unix socket at SOCKET, where the model relay (proxy.py) listens
  outside the jail. A socket file is the only thing that crosses a network namespace.
- `--net host`: the sandbox's own network (installing dependencies needs it).

Either way the command gets a process namespace of its own, with its own /proc: it can't see, signal or
trace a process outside (the relay holds the model credential), and the kernel kills everything it started
the moment it ends, so nothing installed or run in one step is still running in the next.

The namespaces' capabilities are used here, to bring loopback up and mount /proc, and are gone when the
command starts: it runs as the same unprivileged user, holds none over the sandbox's own network, and
can gain none (no_new_privs). Stdlib only. Exits with the command's status.
"""
import argparse
import ctypes
import fcntl
import os
import signal
import socket
import struct
import sys
import threading

CLONE_NEWNS, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET = 0x00020000, 0x10000000, 0x20000000, 0x40000000
MS_NOSUID, MS_NODEV, MS_NOEXEC, MS_REC, MS_PRIVATE = 0x2, 0x4, 0x8, 0x4000, 0x40000
SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1
PR_SET_NO_NEW_PRIVS = 38
libc = ctypes.CDLL(None, use_errno=True)


def fail(what: str) -> None:
    sys.exit(f"pr-eval jail: {what}: {os.strerror(ctypes.get_errno())}")


def loopback_up() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        flags = struct.unpack("16sh", fcntl.ioctl(s, SIOCGIFFLAGS, struct.pack("16sh", b"lo", 0)))[1]
        fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack("16sh", b"lo", flags | IFF_UP))


def pipe(src: socket.socket, dst: socket.socket) -> None:
    """Copy one direction of a connection until it ends, then say so to the other side."""
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def carry(client: socket.socket, path: str) -> None:
    """One connection from inside, carried to the socket outside and back."""
    relay = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        relay.connect(path)
    except OSError:
        client.close()
        relay.close()
        return
    back = threading.Thread(target=pipe, args=(relay, client), daemon=True)
    back.start()
    pipe(client, relay)
    back.join()
    client.close()
    relay.close()


def bridge(listener: socket.socket, path: str) -> None:
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=carry, args=(client, path), daemon=True).start()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--net", choices=("none", "host"), required=True)
    parser.add_argument("--bridge", metavar="PORT=SOCKET", help="with --net none: 127.0.0.1:PORT inside reaches this Unix socket")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or (args.bridge and args.net != "none"):
        parser.error("give a command after --; --bridge needs --net none")
    port, _, path = (args.bridge or "").partition("=")

    uid, gid = os.getuid(), os.getgid()
    if libc.unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | (CLONE_NEWNET if args.net == "none" else 0)):
        fail("no namespaces of its own for the command")
    for name, text in (("uid_map", f"{uid} {uid} 1"), ("setgroups", "deny"), ("gid_map", f"{gid} {gid} 1")):
        with open(f"/proc/self/{name}", "w") as f:
            f.write(text)
    listener = None
    if args.net == "none":
        loopback_up()
        if args.bridge:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", int(port)))
            listener.listen(128)

    first = os.fork()  # the first process of the new process namespace: everything in it ends with this one
    if first:
        if listener:
            listener.close()
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):  # a stop from outside ends the whole jail
            signal.signal(signum, lambda *_: os.kill(first, signal.SIGKILL))
        while True:
            try:
                _, status = os.waitpid(first, 0)
                break
            except InterruptedError:
                continue
        return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)

    # Our own view of the processes: a /proc for this namespace, mounted over the sandbox's. A mount made
    # in a namespace owned by another user namespace never shows outside; private says so outright.
    libc.mount(None, b"/", None, MS_REC | MS_PRIVATE, None)
    if libc.mount(b"proc", b"/proc", b"proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, None):
        fail("no /proc of its own for the command")
    child = os.fork()  # before the bridge's threads start: a fork carries only the thread that made it
    if child == 0:
        if listener:
            listener.close()
        if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0):  # no setuid program or file capability gives any back
            fail("no way to keep the command from gaining privileges")
        try:
            os.execvp(command[0], command)  # the namespaces' capabilities end here
        except OSError as exc:
            print(f"pr-eval jail: {command[0]}: {exc.strerror}", file=sys.stderr)
            os._exit(127)
    if listener:  # already listening, so a connection made before this thread starts waits for it
        threading.Thread(target=bridge, args=(listener, path), daemon=True).start()
    # As the namespace's first process, collect whatever the command leaves behind; when the command
    # itself ends, so does everything else.
    while True:
        try:
            pid, status = os.wait()
        except InterruptedError:
            continue
        except ChildProcessError:
            os._exit(1)
        if pid == child:
            os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))


if __name__ == "__main__":
    sys.exit(main())
