"""Model catalog and pricing, read from configs/models.toml."""
from __future__ import annotations

import os
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
    model: str
    base_url: str
    api_key_env: str

    @property
    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env)

    def problem(self) -> str | None:
        """Why the judge can't run with this key (no key, or no access to the model), else None.

        Asks the provider's model list, which costs nothing. A network hiccup is not a
        problem worth stopping for; a missing model is, since every attempt would then
        come back invalid.
        """
        if not self.api_key:
            return f"the judge needs {self.api_key_env}; set it, or pass --judge none to score on tests only"
        request = urllib.request.Request(f"{self.base_url}/models/{self.model}",
                                         headers={"authorization": f"Bearer {self.api_key}"})
        try:
            urllib.request.urlopen(request, timeout=10).close()
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403, 404):
                return (f"the key in {self.api_key_env} can't use the judge model {self.model} (HTTP {exc.code}); "
                        "use a key that can, or set [judge] model in configs/models.toml")
        except (urllib.error.URLError, TimeoutError):
            pass
        return None


def load(path: Path = DEFAULT_MODELS) -> tuple[dict[str, Model], Judge]:
    data = tomllib.loads(path.read_text())
    default_effort = data.get("defaults", {}).get("effort", "high")
    known = {f.name for f in fields(Model)}
    models = {}
    for key, spec in data["models"].items():
        if unknown := set(spec) - known:
            raise SystemExit(f"{path}: models.{key} has unknown setting(s) {', '.join(sorted(unknown))}")
        models[key] = Model.from_dict({"label": key, "effort": default_effort, **spec, "key": key})
    j = data["judge"]
    return models, Judge(model=j["model"], base_url=j["base_url"].rstrip("/"), api_key_env=j["api_key_env"])


def keychain(service: str) -> str | None:
    """A secret from the macOS Keychain, so a long-lived token never has to sit in a file."""
    if sys.platform != "darwin":
        return None
    p = subprocess.run(["security", "find-generic-password", "-s", service, "-w"], capture_output=True, text=True)
    return (p.stdout.strip() or None) if p.returncode == 0 else None


def credential_env(model: Model) -> dict[str, str]:
    """The provider credential a trial needs, from the environment. Raises SystemExit if unset."""
    if model.provider == "baseten" and os.environ.get("BASETEN_API_KEY"):
        return {"BASETEN_API_KEY": os.environ["BASETEN_API_KEY"]}
    if model.provider == "anthropic":
        for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"):
            if os.environ.get(name):
                return {name: os.environ[name]}
        if token := keychain(KEYCHAIN_SERVICE):
            return {"CLAUDE_CODE_OAUTH_TOKEN": token}
    raise SystemExit(missing_credential(model))


def missing_credential(model: Model) -> str | None:
    """What to set before `model` can run, or None if its key is there."""
    if model.provider == "baseten":
        return None if os.environ.get("BASETEN_API_KEY") else f"{model.label} runs on Baseten Model APIs: set BASETEN_API_KEY."
    if model.provider == "anthropic":
        if any(os.environ.get(n) for n in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")) or keychain(KEYCHAIN_SERVICE):
            return None
        return (f"{model.label} runs on the Anthropic API: set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from "
                "`claude setup-token` (on a Mac you can keep it in the Keychain instead: "
                f"security add-generic-password -a $USER -s {KEYCHAIN_SERVICE} -w).")
    return f"{model.key}: unknown provider {model.provider!r}"
