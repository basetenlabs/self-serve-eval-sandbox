"""Why an attempt wasn't scored, in words, and whether trying it again could help.

An attempt that isn't scored records the step it failed at (`step`), one plain sentence on what
failed (`cause`, for the attempt's sheet and the report), and the file in its folder that shows
it (`log`). Its board cell shows the step's few words. `invalid_reason` stays the short code that
`--resume` and the report count by.
"""
from __future__ import annotations

import errno
import re

from .config import redact_known

# Each step an attempt can fail at, in the few words its board cell has room for.
STEPS = {
    "boot": "Sandbox didn't start",
    "upload": "Source upload failed",
    "setup": "Dependency install failed",
    "network": "Network lock failed",
    "agent": "Agent didn't finish",
    "save": "Saving the diff failed",
    "tests": "Hidden tests didn't run",
    "judge": "Judges didn't answer",
    "cleanup": "Sandbox not deleted",
    "runner": "pr-eval error",
}

# Each invalid reason without an exception behind it: its step and its sentence.
REASONS = {
    "workspace-error": ("upload", "The task's source could not be unpacked in the sandbox."),
    "setup-error": ("setup", "Installing the repository's dependencies failed."),
    "setup-timeout": ("setup", "Installing the repository's dependencies ran out of time."),
    "setup-commit-error": ("setup", "The installed dependencies could not be committed as the starting point."),
    "agent-crashed": ("agent", "Claude Code stopped before it finished, without an answer."),
    "provider-error": ("agent", "The model's provider answered with an error, so the agent could not finish."),
    "verifier-apply-error": ("tests", "The agent's change could not be applied in the verifier sandbox."),
    "verifier-timeout": ("tests", "The hidden tests ran out of time."),
    "task-unstated-name": ("tests", "The hidden tests need a name the request never gives: the task's fault, not the model's."),
    "judge-error": ("judge", "Too few of the judges answered to grade the change."),
    "sandbox-cleanup-error": ("cleanup", "A sandbox of this attempt could not be deleted."),
    "sandbox-error": ("runner", "A sandbox step failed."),
    "runner-error": ("runner", "pr-eval itself failed on this attempt."),
}
# A few words a cell can show for these, where the step's own words would say less.
SHORT = {"setup-timeout": "Dependency install timed out", "agent-crashed": "Agent crashed",
         "provider-error": "Model provider error", "verifier-timeout": "Hidden tests timed out",
         "verifier-apply-error": "Agent's diff didn't apply", "task-unstated-name": "Tests need an unstated name"}

# What each step did, for a sentence about an exception raised in it.
DOING = {
    "boot": "Blaxel could not start {whose} sandbox",
    "upload": "Could not upload the task's files to {whose} sandbox",
    "setup": "Installing dependencies in {whose} sandbox broke off",
    "network": "Could not limit {whose} sandbox's network to the model provider",
    "agent": "The agent's run in its sandbox broke off",
    "save": "Could not save the agent's change from its sandbox",
    "tests": "Running the hidden tests broke off",
    "judge": "Grading the change failed",
    "cleanup": "Deleting {whose} sandbox failed",
    "runner": "pr-eval failed",
}

TRANSIENT_ERRNOS = {errno.ECONNRESET, errno.ECONNREFUSED, errno.ECONNABORTED, errno.ETIMEDOUT, errno.EPIPE,
                    errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN}
TRANSPORT = {"ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ReadError",
             "WriteError", "RemoteProtocolError", "NetworkError", "TimeoutException", "TransportError",
             "ProtocolError", "IncompleteRead", "RemoteDisconnected"}
# How a passing failure reads in a message: a timeout, a dropped connection, a server error or rate limit.
PASSING = re.compile(r"timed? ?out|timeout|connection (?:reset|refused|aborted|closed)|broken pipe|"
                     r"temporarily unavailable|\b(?:429|50[0-4])\b", re.I)
# Our own messages for steps that fail the same way every time they're tried.
LASTING = re.compile(r"must run non-root|did not apply the requested network|GitHub is still reachable|"
                     r"network of their own|Run is stopping", re.I)


def chain(exc: BaseException) -> list[BaseException]:
    """The exception and those it was raised from, outermost first."""
    seen: list[BaseException] = []
    while exc is not None and exc not in seen and len(seen) < 8:
        seen.append(exc)
        exc = exc.__cause__ or exc.__context__
    return seen


def transient(exc: BaseException) -> bool:
    """Whether trying again could go differently: a timeout, a dropped connection, a server error, or
    Blaxel failing to create a sandbox. A local file that can't be read, our own guard refusing, or
    anything else unknown fails the same way again."""
    links = chain(exc)
    if any(LASTING.search(str(e)) for e in links):
        return False
    for e in links:
        status = getattr(e, "status_code", None) or getattr(getattr(e, "response", None), "status_code", None)
        if isinstance(status, int) and (status >= 500 or status == 429):
            return True
        if isinstance(status, int) and status >= 400:  # the request itself was refused: it would be again
            return False
        if isinstance(e, (TimeoutError, ConnectionError)) or type(e).__name__ in TRANSPORT:
            return True
        if isinstance(e, OSError) and e.errno is not None:
            return e.errno in TRANSIENT_ERRNOS
    return any(PASSING.search(str(e)) or str(e).startswith(("Blaxel creation failed", "Blaxel process transport"))
               for e in links)


def plain(exc: BaseException) -> str | None:
    """What went wrong in a few plain words, where the exception says it in a way worth repeating."""
    for e in chain(exc):
        status = getattr(e, "status_code", None) or getattr(getattr(e, "response", None), "status_code", None)
        if isinstance(status, int) and status >= 500:
            return "Blaxel had a server error"
        if status == 429:
            return "Blaxel asked us to slow down"
        if isinstance(e, TimeoutError) or "Timeout" in type(e).__name__:
            return "it timed out"
        if isinstance(e, ConnectionError) or type(e).__name__ in TRANSPORT:
            return "the connection dropped"
        if isinstance(e, OSError) and e.strerror:
            return f"this machine could not read or write a file: {e.strerror.lower()}"
    return None


def describe(exc: BaseException, step: str, whose: str = "the agent's") -> str:
    """One sentence for an exception raised at `step`."""
    why = plain(exc)
    return DOING.get(step, DOING["runner"]).format(whose=whose) + (f" ({why})." if why else ".")


def details(exc: BaseException) -> str:
    """Every link of the exception, for the attempt's error.log: its type and message, redacted."""
    return redact_known("\n".join(f"{type(e).__name__}: {e}"[:2000] for e in chain(exc)))


def short(result: dict) -> str | None:
    """The few words a not-scored attempt's cell shows (about 40 characters)."""
    if result.get("outcome") != "invalid":
        return None
    reason = (result.get("invalid_reason") or "").split(":", 1)[0]
    verifier = reason.startswith("verifier-") and reason not in SHORT and reason not in REASONS
    reason = reason.removeprefix("verifier-") if verifier else reason
    words = SHORT.get(reason) or STEPS.get(result.get("step") or REASONS.get(reason, ("runner",))[0], STEPS["runner"])
    return f"Verifier: {words[0].lower()}{words[1:]}" if verifier else words


def sentence(result: dict) -> str | None:
    """A not-scored attempt's cause in one sentence: its own, or one from its reason for older results."""
    if result.get("outcome") != "invalid":
        return None
    if result.get("cause"):
        return result["cause"]
    reason = (result.get("invalid_reason") or "").split(":", 1)[0]
    verifier = reason.startswith("verifier-") and reason not in REASONS
    text = REASONS.get(reason.removeprefix("verifier-") if verifier else reason, (None, None))[1]
    if not text:
        return "This attempt was not scored; its log says why." if reason else None
    return f"In the verifier sandbox: {text[0].lower()}{text[1:]}" if verifier else text


def provider(message: str) -> str:
    """A provider error in one sentence, with the provider's own words: "rate limit exceeded" says more than
    "an error"."""
    said = re.sub(r"^\s*API Error:\s*", "", (message or "").strip().splitlines()[0] if message.strip() else "")
    said = said.replace(" · ", ": ").strip().rstrip(".")[:160]
    base = REASONS["provider-error"][1]
    return f"{base[:-1]} ({said})." if said else base


def signature(result: dict) -> tuple[str, str] | None:
    """How a lost attempt failed, the same for attempts that failed the same way: its step and cause,
    without the names of its sandboxes."""
    if result.get("outcome") != "invalid":
        return None
    cause = re.sub(r"pr-eval-[a-z0-9-]+", "<sandbox>", sentence(result) or "")
    return (result.get("step") or "", cause)
