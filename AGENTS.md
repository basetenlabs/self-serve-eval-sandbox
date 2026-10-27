# AGENTS.md

Setting pr-eval up for someone rather than changing it? Follow [SETUP.md](SETUP.md).

Rules for anyone (human or agent) working in this repo:

- No customer names, customer data or customer-identifying details anywhere: code, docs, sample data, commit messages, branch names or generated reports. Sample data comes from public repositories only.
- API keys come from environment variables (or, for the Claude token, the macOS Keychain), never from files in the repo. Never commit keys, tokens or run outputs that contain them.
- The answer never reaches the agent: merged diffs, the PR's tests and the repository clones in `data/repos/` stay outside the agent sandbox; delete that sandbox before uploading hidden tests to a fresh verifier sandbox. `--keep-sandboxes` may retain only verifiers. Agents get no route to GitHub or package registries while they work. The one exception is the request's "Names the tests use" list: signatures only, never a body, a value or a changed return type. A change that weakens this needs a test.
- Setup, provider, verifier and judge errors are invalid attempts, never model failures. A task joins a run only after `pr-eval validate` passes it in the trial image.
- `docker/proxy.py` is vendored from `basetenlabs/harness-evals`: change it there first, then copy it here.
- Keep it simple to pick up: the quickstart is install, then `pr-eval serve`, and everything else happens on that page. The page and `pr-eval run` go through the same code (`pipeline.py`), so add features there, not in one of them. A change that adds a step for the user needs a good reason.
- Run cloud work only in an explicitly configured, dedicated Blaxel workspace (`PR_EVAL_BLAXEL_WORKSPACE`, `--workspace`, or `~/.config/pr-eval/blaxel.json`); never use `main` or the CLI's implicit current workspace. Preserve the workspace and image identity on resume, and reject legacy Docker resumes. Tests must not call cloud APIs.
- The page and the report are built from `web/` (React, Tailwind, shadcn-style components) into `eval_sandbox/app.html` and `eval_sandbox/report_template.html`, so `pr-eval` needs no Node. Edit `web/src`, then `cd web && npm ci && npm run build` and commit the built files with it; a unit test fails when they're stale.
- The UI follows the Baseten figure style: the exact brand palette, green for open models on Baseten, blue for the closed comparison, a pink chip for the difference between them, gold for anything outside (the judges, not-scored attempts). No rounded corners, 1px rules, mono uppercase labels, dashed for "not yet". Keep new colours and components inside `web/src/styles/globals.css` and `web/src/components/`.
- The hosted page's sign-in is the `@blaxel/sign-in` package (`hosted/server.mjs`, `hosted/site.config.mjs`): upgrade it with npm, never copy or edit its files. Hosted, the page reads who is asking only from `X-Forwarded-Email`, which the sign-in sets; never trust another identity header.
- Before committing, run the unit tests (no cloud, network or keys needed): `python3 -m unittest discover -s tests`, and `cd web && npm run check` after changing `web/`.
