# self-serve-eval-sandbox

Can an open model do your team's real coding work? `pr-eval` takes pull requests your team already merged and hands each one to Claude Code twice: once with a closed model, once with an open model. It grades both and reports how many tasks each model solves and what each solved task costs.

Status: v0. Claude Code is the only harness. MIT licensed.

Setting it up with a coding agent? Give it this repository's link and [SETUP.md](SETUP.md), a step-by-step guide with a check after each step.

## What you need

- Python 3.12, 3.13 or 3.14 (the Blaxel SDK doesn't install on 3.15 yet).
- The GitHub CLI, signed in: `gh auth login`.
- A **new, dedicated [Blaxel](https://app.blaxel.ai) workspace** that can run 16 sandboxes at once (40 for the quick sample). Don't use a main, shared or in-use workspace. No local Docker is needed.
- Three provider keys, as environment variables:

| Variable | For |
| --- | --- |
| `BASETEN_API_KEY` | open models on Baseten Model APIs, and the Kimi K3 judge |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude models, and the Claude Opus 5.5 judge (install `claude` too) |
| `OPENAI_API_KEY` | the GPT-6.1 Sol judge |

Model calls and Blaxel compute cost money. The quick sample costs about $2.

## Quickstart

Install the Blaxel CLI and point pr-eval at your dedicated workspace (replace `dedicated-eval-workspace` with its name):

```bash
curl -fsSL https://blaxel.ai/install.sh | BL_INSTALL_SETUP=false sh
bl login dedicated-eval-workspace
mkdir -p ~/.config/pr-eval
printf '%s\n' '{"workspace":"dedicated-eval-workspace"}' > ~/.config/pr-eval/blaxel.json
```

`PR_EVAL_BLAXEL_WORKSPACE` or `--workspace` work too. There's no fallback to the CLI's current workspace, and `main` is refused.

Install and start the page:

```bash
python3.13 -m venv .venv && source .venv/bin/activate && pip install -e .
pr-eval serve
```

It opens http://127.0.0.1:8765, with a checklist of anything still missing. Then:

1. Pick the **Quick sample** (10 merged PRs from 6 public repositories, a few minutes) or **Your pull requests**: paste links, or type a repository and pick from its merges.
2. Choose the models to compare (Claude Opus 5.5 and DeepSeek V4.1 Flash to start).
3. Press **Start run**. When it finishes, **Open report** shows solve rate, cost per solved task and time per task, with every attempt's diff, trace, test output and the judges' verdicts.

The first run builds the trial image on Blaxel, which takes a few minutes once. Private repositories work through your `gh` login.

Go and Python repositories have default install and test commands. For anything else, open **Install and test commands** and say how, for example `npm ci` and `npx vitest run {test_files}`. The trial image has Go, Node and Python; add other toolchains in `docker/Dockerfile`.

## From a terminal

The page runs this same command:

```bash
pr-eval run your-org/your-repo --limit 10 --models claude-opus,deepseek-v4.1-flash
pr-eval run                                         # the sample tasks
pr-eval run your-org/your-repo --pr 123 --pr 456    # exactly these PRs
pr-eval run https://github.com/o/a/pull/12 x/b#9    # or links, from any number of repositories
```

Stop with Ctrl-C and continue with `pr-eval run --resume jobs/<run>`. On a finished run, add `--attempts 3` for more attempts or `--models kimi-k3` to add a model. `pr-eval <command> --help` lists the options.

| Command | Does |
| --- | --- |
| `pr-eval serve` | the page: start runs, watch them, open their reports |
| `pr-eval run [owner/repo]` | find PRs, check them, run each model, grade and report |
| `pr-eval collect [owner/repo]` | only turn merged PRs into task folders in `tasks/` |
| `pr-eval report jobs/<run>` | rebuild a run's report |
| `pr-eval validate` | check task folders in the trial image without running a model |
| `pr-eval rejudge jobs/<run>` | grade a finished run again with the current judges |
| `pr-eval retest jobs/<run>` | rerun a finished run's hidden tests from its saved diffs |
| `pr-eval cleanup` | remove sandboxes a killed run left behind |
| `pr-eval build-image` | rebuild the trial image on Blaxel |

## Where your code goes

- The repository clone stays on your machine, in `data/repos/`.
- Each attempt runs in a fresh sandbox in your Blaxel workspace, starting from the repository as it was before the merge. While the agent works it can reach only the model provider: no GitHub, no package registries, no web tools.
- When the agent stops, its sandbox is deleted. Only then do its diff and the PR's hidden tests go to a separate sandbox for grading. The agent never sees the answer.
- Code the agent reads goes to the model being tested (Anthropic or Baseten). Diffs go to the judges (Anthropic, OpenAI and Baseten).
- Transcripts and reports are saved locally in `jobs/`. Treat them as sensitive.
- Sandboxes are deleted after use. If the process is killed, `pr-eval cleanup --workspace <name>` removes what's left.
- Setup commands are trusted: they run with network access, before the allowlist is narrowed.
- Keys come only from the environment (or, for the Claude token, the macOS Keychain; see [SETUP.md](SETUP.md)), never from files.

## How it works

1. **Collect.** Each merged PR becomes a task. The PR's text, or the issue it closes, is the request. The merged diff and the PR's tests are kept aside as the answer. Before any model runs, the PR's tests must fail without the change and pass with it; PRs that don't are left out.
2. **Run.** Claude Code works on the request with the model under test. Open models on Baseten go through a small proxy in the sandbox that sets the same reasoning effort on every request.
3. **Grade.** The PR's hidden tests run against the agent's code. Then three LLM judges (Claude Opus 5.5, GPT-6.1 Sol and Kimi K3) each compare its diff with the merged one, and Kimi K3 writes the final verdict. Solved means the tests pass and the judges agree.
4. **Report.** One HTML page per run, plus `report.json`.

## What the numbers mean

- **Solve rate**: solved attempts / valid attempts, with a 95% range. With a few dozen tasks, a few points' difference is noise.
- **Cost per solved task**: model spend / solved attempts, so a model that fails often pays for its failures. Judges and Blaxel compute aren't included.
- **Invalid attempts**: setup, provider, test or judge errors. Reported, never counted as failures.
- A merge date after a model's training cutoff makes memorization less likely, not impossible.

## Models

`configs/models.toml` lists the models and their prices: `claude-opus`, `glm-5.3`, `kimi-k3`, `muse-spark`, `deepseek-v4.1-flash`, `nemotron-3.5-super`. To add one, copy an entry and set its Baseten model id and prices.

## Development

```bash
python3 -m unittest discover -s tests     # no cloud, network or keys needed
cd web && npm run check                   # the page's type check and unit tests
```

The page and the report are a React app in `web/`, built into `eval_sandbox/app.html` and `eval_sandbox/report_template.html`, so running `pr-eval` needs no Node. To change them (Node 20.19, or 22.12 and later):

```bash
cd web
npm ci
npm run dev        # live reload at http://localhost:5173, against `pr-eval serve` on port 8765
npm run build      # rebuilds the two HTML files; commit them with the source change
```

`hosted/` is the deployment behind our hosted copy of the page. You don't need it to run pr-eval.
