# Set up pr-eval, step by step

This guide is written so a coding agent can follow it from start to finish. Give your agent the link to this repository and say:

> Set up pr-eval from this repository by following SETUP.md. Ask me before anything that needs my accounts or costs money.

The finished setup runs the page at http://127.0.0.1:8765, where you pick merged pull requests and models and start a run. Every step below says how to check it worked. Where a step needs the person (a sign-in, a key, a new workspace), the agent should stop and ask for exactly that.

## What it costs and what it touches

- **Model calls** go to Anthropic (the closed model, and one judge), Baseten Model APIs (the open models, and one judge) and OpenAI (one judge). The quick sample, 10 pull requests with two models, costs about $2 to $4 and takes 5 to 8 minutes.
- **Compute** runs in Blaxel sandboxes in a workspace used only for this. Nothing runs in Docker on your machine.
- **Your code**: repository clones stay on your machine, in `data/repos/`. Each attempt uploads the code from before the change to a sandbox. The README's "Where your code goes" section has the details.

## 1. Python 3.12, 3.13 or 3.14

The Blaxel SDK does not install on Python 3.15 yet.

```bash
for v in 3.13 3.12 3.14; do command -v python$v && break; done
```

Check: it prints a path. If it prints nothing, install Python 3.13 (on a Mac: `brew install python@3.13`) and run it again.

## 2. Install

```bash
git clone https://github.com/basetenlabs/self-serve-eval-sandbox.git
cd self-serve-eval-sandbox
python3.13 -m venv .venv          # the version step 1 found
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

## 4. A dedicated Blaxel workspace

Runs create and delete many sandboxes, so they get a workspace of their own. pr-eval refuses `main` and never falls back to whichever workspace the CLI happens to have selected.

1. The person creates a workspace in the [Blaxel console](https://app.blaxel.ai): click the workspace name at the bottom left, then **Switch** > **+**. Give it a name such as `pr-eval`. Make sure it can run 40 sandboxes at once: the quick sample starts all 20 of its attempts together, each with a sandbox for the agent and one for grading. Other runs use up to 16.
2. Install the Blaxel CLI and sign in to that workspace (the person may need to finish the sign-in in a browser):

```bash
curl -fsSL https://blaxel.ai/install.sh | BL_INSTALL_SETUP=false sh
bl login pr-eval                  # the new workspace's name
mkdir -p ~/.config/pr-eval
printf '%s\n' '{"workspace":"pr-eval"}' > ~/.config/pr-eval/blaxel.json
```

Check: `bl workspaces` lists `pr-eval`. The saved file holds only the workspace's name, never a credential.

## 5. Keys

Ask the person for these. Keep them in the environment of the shell that starts the page; never write them into a file in the repository.

| Variable | What it's for | Where to get it |
| --- | --- | --- |
| `BASETEN_API_KEY` | open models, and the Kimi K3 judge | Baseten: Settings > API keys |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` | Claude models, and the Claude Opus 5.5 judge | Anthropic Console, or `claude setup-token` (the person runs it) |
| `OPENAI_API_KEY` | the GPT-6.1 Sol judge | OpenAI platform: API keys |

The Claude judge runs through Claude Code, so install it too: `npm install -g @anthropic-ai/claude-code`. On a Mac, the Claude token can live in the Keychain instead of the environment: `security add-generic-password -a "$USER" -s pr-eval-claude-code-oauth-token -w`.

## 6. Start the page and read its checklist

```bash
.venv/bin/pr-eval serve --no-open &
sleep 3
curl -s 127.0.0.1:8765/api/state | .venv/bin/python -c '
import json, sys
s = json.load(sys.stdin)
c = s["checks"]
print("Blaxel workspace:", c["blaxel"], c["blaxel_problem"] or "")
print("Blaxel CLI:", c["bl_cli"], "| GitHub:", c["gh"], c["gh_login"] or "", "| trial image built:", c["image"])
print("Judges:", c["judge"]["ok"], c["judge"]["problem"] or "")
print("Models missing a key:", [m["key"] for m in s["models"] if m["missing"]] or "none")'
```

Check: every line says `True`, except "trial image built", which turns `True` after the first run builds the image (a few minutes, once). `pr-eval build-image` builds it ahead of time. Each problem line says what is missing.

Then open http://127.0.0.1:8765. The checklist on the right of the page shows the same things.

## 7. First run

Ask the person before starting a run, since it spends money. On the page, choose **Quick sample**, keep the two default models and press **Start run**. From a terminal, this does the same:

```bash
.venv/bin/pr-eval run --quick --concurrency 20    # every attempt at once, as the page does
```

Check: the run ends with `Finished. Report: jobs/<run>/report.html`. On the page, **Open report** shows solve rate, cost per solved task and time for each model.

## 8. Your own repository

On the page, choose **Your pull requests** and type `owner/repo`, or paste links to pull requests. Star the ones that stand for your team's work: they collect under **Your eval suite**, so the next model gets the same test. **Run again** on a finished run puts its pull requests and models back in the form, ready for a new model.

From a terminal:

```bash
.venv/bin/pr-eval run your-org/your-repo --limit 10
```

Go and Python repositories need nothing more. For other languages, give the install and test commands, for example `--setup "npm ci" --test "npx vitest run {test_files}"`, where `{test_files}` becomes the pull request's changed test files.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| `requires a different Python: 3.15...` | Use Python 3.12 to 3.14 (step 1). |
| The page says the Blaxel workspace isn't set | Write `~/.config/pr-eval/blaxel.json` (step 4), or pass `--workspace`. |
| A model shows "Needs its API key" | Export that model's key (step 5) in the shell that runs `pr-eval serve`, then restart it. |
| A judge problem in the checklist | That judge's key is missing, or Claude Code isn't installed (step 5). `--judge none` scores on tests alone. |
| A pull request is "left out" | Its tests didn't fail before the change and pass after it, in the trial image. That's a setup problem, not the model's. |
| A run was stopped or its process killed | **Resume** on the page, or `pr-eval run --resume jobs/<run>`. |

## Remove it

```bash
.venv/bin/pr-eval cleanup --workspace pr-eval   # deletes sandboxes a killed run left behind
rm -rf self-serve-eval-sandbox                  # the clone, its virtualenv, run results and repository clones
rm -f ~/.config/pr-eval/blaxel.json
security delete-generic-password -s pr-eval-claude-code-oauth-token   # only if you stored the token on a Mac
```

The person can then delete the Blaxel workspace in the console, and revoke any keys made for this.
