# Set up pr-eval, step by step

This guide is written so a coding agent can follow it from start to finish. Give your agent the link to this repository and say:

> Set up pr-eval from this repository by following SETUP.md. Ask me before anything that needs my accounts or costs money.

The finished setup runs the page at http://127.0.0.1:8765, where you pick merged pull requests and models and start a run. Every step below says how to check it worked. Where a step needs the person (a sign-in, a key), the agent should stop and ask for exactly that.

## What it costs and what it touches

- **Model calls** go to Anthropic (the closed model, and one judge), Baseten Model APIs (the open models, and one judge) and OpenAI (one judge). The quick sample, 10 PostHog pull requests with two models, costs about $12 and takes about 35 minutes.
- **Compute** runs in Baseten Sandboxes, in the team of the Baseten key from step 4. Nothing runs in Docker on your machine.
- **Your code**: repository clones stay on your machine, in `data/repos/`. Each attempt uploads the code from before the change to a sandbox. The README's "Where your code goes" section has the details.

## 1. Python 3.12 or later

```bash
for v in 3.13 3.14 3.12; do PY=$(command -v python$v) && break; done; echo "$PY"
```

Check: it prints a path. Keep `$PY` for the next step. If it prints nothing, install Python 3.13 (on a Mac: `brew install python@3.13`) and run it again.

## 2. Install

```bash
git clone https://github.com/basetenlabs/self-serve-eval-sandbox.git
cd self-serve-eval-sandbox
"$PY" -m venv .venv               # the Python step 1 found
.venv/bin/pip install -e .
.venv/bin/pr-eval --help
```

Check: the last command lists `serve`, `run`, `report` and the other commands.

## 3. GitHub CLI

pr-eval reads pull requests and clones repositories with the GitHub CLI's login.

```bash
gh auth status
```

Check: it says you are logged in. If `gh` is missing, install it (`brew install gh`). If you are not logged in, the person runs `gh auth login` themselves, because it opens a browser.

## 4. Keys

Ask the person for these. Keep them in the environment of the shell that starts the page; never write them into a file in the repository.

| Variable | What it's for | Where to get it |
| --- | --- | --- |
| `BASETEN_API_KEY` | the sandboxes attempts run in, open models, and the Kimi K3 judge | Baseten: Settings > API keys. A personal key, or a team creator service account key |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` | Claude models, and the Claude Opus 5.5 judge | Anthropic Console, or `claude setup-token` (the person runs it) |
| `OPENAI_API_KEY` | the GPT-6.1 Sol judge | OpenAI platform: API keys |

A model-only Baseten key can call models but can't create sandboxes. To keep one in `BASETEN_API_KEY`, put a key that can in `BASETEN_SANDBOX_API_KEY`. Set `BASETEN_TEAM_ID` to pin the team the sandboxes go in: a key that can't reach that team is then refused instead of running somewhere else. There is no workspace to make and no CLI to install.

Check that the key can create sandboxes (it prints `200`; `403` means a model-only key):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.baseten.co/v1/token \
  -H "Authorization: Bearer ${BASETEN_SANDBOX_API_KEY:-$BASETEN_API_KEY}" -H 'Content-Type: application/json' -d '{"scopes":["sandboxes"]}'
```

An attempt uses two sandboxes at once, one for the agent and one for grading. Baseten runs 10 sandboxes at once for an organization until you ask for more ([Manage sandboxes](https://docs.baseten.co/sandboxes/manage)). The quick sample starts all 20 of its attempts together and other runs up to 8; when the count is full, a new sandbox waits for one to finish. Until the limit is raised, run from a terminal with `--concurrency` set to a quarter of it (step 6).

The Claude judge runs through Claude Code, so install it too: `curl -fsSL https://claude.ai/install.sh | bash` (no Node needed), or `npm install -g @anthropic-ai/claude-code`. Check: `claude --version` prints a version. On a Mac, the Claude token can live in the Keychain instead of the environment: `security add-generic-password -a "$USER" -s pr-eval-claude-code-oauth-token -w`.

## 5. Start the page and read its checklist

```bash
.venv/bin/pr-eval serve --no-open &
sleep 3
curl -s 127.0.0.1:8765/api/state | .venv/bin/python -c '
import json, sys
s = json.load(sys.stdin)
c = s["checks"]
print("Baseten Sandboxes:", c["sandboxes"], c["sandboxes_problem"] or "")
print("GitHub:", c["gh"], c["gh_login"] or "", "| trial image built:", c["image"])
print("Judges:", c["judge"]["ok"], c["judge"]["problem"] or "")
print("Models missing a key:", [m["key"] for m in s["models"] if m["missing"]] or "none")'
```

Check: every line says `True`, except "trial image built", which turns `True` after the first run builds the image (a few minutes, once). `pr-eval build-image` builds it ahead of time. Each problem line says what is missing.

Then open http://127.0.0.1:8765. The checklist on the right of the page shows the same things.

## 6. First run

Ask the person before starting a run, since it spends money. On the page, choose **Quick sample**, keep the two default models and press **Start run**. From a terminal, this does the same:

```bash
.venv/bin/pr-eval run --quick --concurrency 20    # every attempt at once, as the page does
```

Check: the run ends with `Finished. Report: jobs/<run>/report.html`. On the page, **Open report** shows solve rate, cost per solved task and time for each model.

## 7. Your own repository

On the page, choose **Your pull requests** and type `owner/repo`, or paste links to pull requests. Star the ones that stand for your team's work: they collect under **Your eval suite**, so the next model gets the same test. **Run again** on a finished run puts its pull requests and models back in the form, ready for a new model.

From a terminal:

```bash
.venv/bin/pr-eval run your-org/your-repo --limit 10
```

Go and Python repositories need nothing more. For other languages, give the install and test commands, for example `--setup "npm ci" --test "npx vitest run {test_files}"`, where `{test_files}` becomes the pull request's changed test files.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| `requires a different Python` | Use Python 3.12 or later (step 1). |
| The page says the Baseten key can't create sandboxes | It is a model-only key. Use a personal key or a team creator service account key, in `BASETEN_API_KEY` or `BASETEN_SANDBOX_API_KEY` (step 4), then restart `pr-eval serve`. |
| The run's log says "Baseten's sandbox count is full" | The organization is at its sandbox limit, and the run is waiting for room. It goes on by itself; a lower `--concurrency` stops the waiting, and Baseten can raise the limit. |
| A model shows "Needs its API key" | Export that model's key (step 4) in the shell that runs `pr-eval serve`, then restart it. |
| A judge problem in the checklist | That judge's key is missing, or Claude Code isn't installed (step 4). `--judge none` scores on tests alone. |
| A pull request is "left out" | Its tests didn't fail before the change and pass after it, in the trial image. That's a setup problem, not the model's. |
| Left out: "its tests need what its request never says" | The chair judge compared the PR's text with its merged diff and tests and found the tests check behavior or names the text never states. The verdict is in the task folder's `screen.json`; delete it to ask again. |
| A run was stopped or its process killed | **Resume** on the page, or `pr-eval run --resume jobs/<run>`. |

## Remove it

```bash
kill $(lsof -ti tcp:8765)                       # stops the page, if it is still running
.venv/bin/pr-eval cleanup                       # deletes sandboxes a killed run left behind
cd ..
rm -rf self-serve-eval-sandbox                  # the clone, its virtualenv, run results and repository clones
security delete-generic-password -s pr-eval-claude-code-oauth-token   # only if you stored the token on a Mac
```

The person can then revoke any keys made for this. The trial image stays in the Baseten team; remove it with `baseten sandbox image delete` or from the console if nothing else uses it.
