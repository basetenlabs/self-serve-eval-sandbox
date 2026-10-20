# AGENTS.md

Rules for anyone (human or agent) working in this repo:

- No customer names, customer data or customer-identifying details anywhere: code, docs, sample data, commit messages, branch names or generated reports. Sample data comes from public repositories only.
- API keys come from environment variables (or, for the Claude token, the macOS Keychain), never from files in the repo. Never commit keys, tokens or run outputs that contain them.
- The answer never reaches the agent: merged diffs, the PR's tests and the repository clones in `data/repos/` stay outside the agent sandbox; delete that sandbox before uploading hidden tests to a fresh verifier sandbox. `--keep-sandboxes` may retain only verifiers. Agents get no route to GitHub or package registries while they work. The one exception is the request's "Names the tests use" list: signatures only, never a body, a value or a changed return type. A change that weakens this needs a test.
- Setup, provider, verifier and judge errors are invalid attempts, never model failures. A task joins a run only after `pr-eval validate` passes it in the trial image.
- `docker/proxy.py` is vendored from `basetenlabs/harness-evals`: change it there first, then copy it here.
- Keep it simple to pick up: the quickstart is install, then `pr-eval serve`, and everything else happens on that page. The page and `pr-eval run` go through the same code (`pipeline.py`), so add features there, not in one of them. A change that adds a step for the user needs a good reason.
- Run cloud work only in an explicitly configured, dedicated Blaxel workspace (`PR_EVAL_BLAXEL_WORKSPACE`, `--workspace`, or `~/.config/pr-eval/blaxel.json`); never use `main` or the CLI's implicit current workspace. Preserve the workspace and image identity on resume, and reject legacy Docker resumes. Tests must not call cloud APIs.
- Before committing, run the unit tests (no cloud, network or keys needed): `python3 -m unittest discover -s tests`.
