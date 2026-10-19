# AGENTS.md

Rules for anyone (human or agent) working in this repo:

- No customer names, customer data or customer-identifying details anywhere: code, docs, sample data, commit messages, branch names or generated reports. Sample data comes from public repositories only.
- API keys come from environment variables (or, for the Claude token, the macOS Keychain), never from files in the repo. Never commit keys, tokens or run outputs that contain them.
- The answer never reaches the agent: merged diffs, the PR's tests and the repository clones in `data/repos/` stay outside a trial container until the agent stops, and agents get no route to GitHub or package registries while they work. A change that weakens this needs a test.
- Setup, provider, verifier and judge errors are invalid attempts, never model failures. A task joins a run only after `pr-eval validate` passes it in the trial image.
- `docker/proxy.py` is vendored from `basetenlabs/harness-evals`: change it there first, then copy it here.
- Keep it simple to pick up: the quickstart is install, then `pr-eval serve`, and everything else happens on that page. The page and `pr-eval run` go through the same code (`pipeline.py`), so add features there, not in one of them. A change that adds a step for the user needs a good reason.
- Before committing, run the unit tests (no Docker, network or keys needed): `python3 -m unittest discover -s tests`.
