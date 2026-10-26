"""Model catalog and pricing, read from configs/models.toml."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass, field, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS = ROOT / "configs" / "models.toml"
BASETEN_URL = "https://inference.baseten.co/v1"
KEYCHAIN_SERVICE = "pr-eval-claude-code-oauth-token"


@dataclass
class Model:
    key: str
    label: str
    kind: str          # "closed" or "open"
    provider: str      # "anthropic" or "baseten"
    model: str         # the id the provider serves
    effort: str
    prices: dict[str, dict[str, float]] = field(default_factory=dict)
    max_concurrent: int | None = None  # cap for providers that rate-limit a key

    def price(self, usage: dict[str, dict]) -> float | None:
        """USD for Claude Code's per-model usage, priced from our own table.

        `usage` is Claude Code's `modelUsage`: {model id: {inputTokens, outputTokens,
        cacheReadInputTokens, cacheCreationInputTokens}}, optionally with
        cacheCreation1hInputTokens, the part of the cache writes kept for an hour.
        Returns None if a model in the usage has no price, so a missing rate never reads
        as a cheap run.
        """
        total = 0.0
        for model_id, counts in usage.items():
            rates = self.rate_for(model_id)
            if rates is None:
                return None
            write = rates.get("cache_write", rates["input"])
            write_1h = counts.get("cacheCreation1hInputTokens", 0)
            total += (counts.get("inputTokens", 0) * rates["input"]
                      + counts.get("cacheReadInputTokens", 0) * rates.get("cached_input", rates["input"])
                      + (counts.get("cacheCreationInputTokens", 0) - write_1h) * write
                      + write_1h * rates.get("cache_write_1h", write)
                      + counts.get("outputTokens", 0) * rates["output"]) / 1e6
        return total

    def rate_for(self, model_id: str) -> dict | None:
        if model_id in self.prices:
            return self.prices[model_id]
        # Claude Code reports dated or suffixed ids (e.g. "claude-haiku-4-5-20251001").
        for known, rates in self.prices.items():
            if model_id.startswith(known):
                return rates
        return None

    def as_dict(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)}

    @classmethod
    def from_dict(cls, spec: dict) -> Model:
        """The inverse of as_dict; fields it doesn't name keep their defaults."""
        return cls(**{f.name: spec[f.name] for f in fields(cls) if f.name in spec})


@dataclass
class Judge:
    """One judge model: a Claude model through Claude Code, or any Chat Completions endpoint."""
    model: str
    base_url: str = ""  # an OpenAI-compatible endpoint; a Claude judge has none
    api_key_env: str = ""
    provider: str = "openai"  # "anthropic": Claude Code with the Claude models' credential
    effort: str | None = None  # reasoning_effort, or Claude Code's --effort
    label: str | None = None  # how the page names it
    json_mode: bool = True  # ask for a JSON reply with response_format; the prompt asks for JSON either way
    max_concurrent: int | None = None  # requests at once, for a provider that rate-limits the key

    @property
    def name(self) -> str:
        return self.label or self.model

    @property
    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env) if self.api_key_env else None

    def summary(self) -> dict:
        return {"model": self.model, "label": self.name, "provider": self.provider, "effort": self.effort}

    def problem(self) -> str | None:
        """Why the judge can't run with this key (no key, or no access to the model), else None.

        Asks the provider's model list, which costs nothing. A network hiccup is not a
        problem worth stopping for; a missing model is, since every attempt would then
        come back invalid.
        """
        if self.provider == "anthropic":
            if not shutil.which("claude"):
                return (f"the {self.name} judge runs through Claude Code: install it "
                        "(npm install -g @anthropic-ai/claude-code), or pass --judge none to score on tests only")
            if not claude_credential():
                return f"the {self.name} judge needs a Claude credential: {CLAUDE_CREDENTIAL_HELP}"
            return None
        if not self.api_key:
            return f"the {self.name} judge needs {self.api_key_env}; set it, or pass --judge none to score on tests only"
        cannot = (f"the key in {self.api_key_env} can't use the judge model {self.model}"
                  "{}; use a key that can, or change its [[judge.panel]] entry in configs/models.toml")
        request = urllib.request.Request(f"{self.base_url}/models", headers={"authorization": f"Bearer {self.api_key}"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                listed = {m.get("id") for m in json.loads(response.read()).get("data") or []}
        except urllib.error.HTTPError as exc:
            return cannot.format(f" (HTTP {exc.code})") if exc.code in (401, 403) else None
        except (urllib.error.URLError, TimeoutError, ValueError, AttributeError):
            return None
        return cannot.format(f" (not in {self.base_url}/models)") if listed and self.model not in listed else None


@dataclass
class Panel:
    """The judges, each grading every attempt on its own, and the chair that turns their verdicts into one."""
    judges: list[Judge]
    chair: Judge | None = None  # None when one judge's verdict is final

    @property
    def name(self) -> str:
        """Who grades, as each verdict records it, so a rejudge can tell a new panel from the same one."""
        judges = "+".join(j.model for j in self.judges)
        return f"{judges}>{self.chair.model}" if self.chair else judges

    @property
    def label(self) -> str:
        names = [j.name for j in self.judges]
        return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"

    def problem(self) -> str | None:
        seen = set()
        for judge in [*self.judges, *([self.chair] if self.chair else [])]:
            if judge.model not in seen and (problem := judge.problem()):
                return problem
            seen.add(judge.model)
        return None

    def only(self, model: str) -> Panel:
        """A panel of just one of these judges, named by model id or label."""
        for judge in [*self.judges, *([self.chair] if self.chair else [])]:
            if model in (judge.model, judge.label):
                return Panel([judge])
        raise SystemExit(f"no judge {model!r}; the panel has {', '.join(j.model for j in self.judges)}")

    def as_dict(self) -> dict:
        return {"model": self.name, "label": self.label, "panel": [j.summary() for j in self.judges],
                "chair": self.chair.summary() if self.chair else None}


def load(path: Path = DEFAULT_MODELS) -> tuple[dict[str, Model], Panel]:
    data = tomllib.loads(path.read_text())
    default_effort = data.get("defaults", {}).get("effort", "high")
    known = {f.name for f in fields(Model)}
    models = {}
    for key, spec in data["models"].items():
        if unknown := set(spec) - known:
            raise SystemExit(f"{path}: models.{key} has unknown setting(s) {', '.join(sorted(unknown))}")
        models[key] = Model.from_dict({"label": key, "effort": default_effort, **spec, "key": key})
    return models, load_panel(data["judge"], data.get("defaults", {}).get("effort"), path)


def load_panel(spec: dict, default_effort: str | None, path: Path) -> Panel:
    """[judge] with its [[judge.panel]] entries, or, written before panels, one judge's own settings."""
    known = {f.name for f in fields(Judge)}
    entries = spec.get("panel") or [{k: v for k, v in spec.items() if k != "chair"}]
    judges = []
    for i, judge in enumerate(entries):
        if unknown := set(judge) - known:
            raise SystemExit(f"{path}: judge.panel[{i}] has unknown setting(s) {', '.join(sorted(unknown))}")
        judge = {"effort": spec.get("effort", default_effort), **judge}
        judges.append(Judge(**{**judge, "base_url": judge.get("base_url", "").rstrip("/")}))
    chair = next((j for j in judges if spec.get("chair") in (j.model, j.label)), None)
    if spec.get("chair") and not chair:
        raise SystemExit(f"{path}: judge.chair {spec['chair']!r} isn't one of the judge.panel models")
    return Panel(judges, chair)


def keychain(service: str) -> str | None:
    """A secret from the macOS Keychain, so a long-lived token never has to sit in a file."""
    if sys.platform != "darwin":
        return None
    p = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True)
    return (p.stdout.strip() or None) if p.returncode == 0 else None


CLAUDE_CREDENTIAL_HELP = ("set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` (on a Mac you "
                          "can keep it in the Keychain instead: security add-generic-password -a $USER -s "
                          f"{KEYCHAIN_SERVICE} -w).")


def claude_credential() -> dict[str, str]:
    """What Claude Code signs in with, for the Claude models and the Claude judge: {variable: value}, or {}."""
    for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"):
        if os.environ.get(name):
            return {name: os.environ[name]}
    if token := keychain(KEYCHAIN_SERVICE):
        return {"CLAUDE_CODE_OAUTH_TOKEN": token}
    return {}


def credential_env(model: Model) -> dict[str, str]:
    """The provider credential a trial needs, from the environment. Raises SystemExit if unset."""
    if model.provider == "baseten" and os.environ.get("BASETEN_API_KEY"):
        return {"BASETEN_API_KEY": os.environ["BASETEN_API_KEY"]}
    if model.provider == "anthropic" and (credential := claude_credential()):
        return credential
    raise SystemExit(missing_credential(model))


def missing_credential(model: Model) -> str | None:
    """What to set before `model` can run, or None if its key is there."""
    if model.provider == "baseten":
        return None if os.environ.get("BASETEN_API_KEY") else f"{model.label} runs on Baseten Model APIs: set BASETEN_API_KEY."
    if model.provider == "anthropic":
        return None if claude_credential() else f"{model.label} runs on the Anthropic API: {CLAUDE_CREDENTIAL_HELP}"
    return f"{model.key}: unknown provider {model.provider!r}"
