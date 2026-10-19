# self-serve-eval-sandbox

Check whether an open model can do your team's real coding work. `pr-eval` replays merged pull requests through Claude Code, once with a closed model and once with an open model, and reports how many tasks each solves and what each solved task costs.

Status: v0. Claude Code is the only harness.

## Quickstart

You need Docker with room for four containers at once (Docker Desktop with 8 CPUs and 12 GB under Settings > Resources, or `colima start --cpu 8 --memory 12`), Python 3.12+, the GitHub CLI (`gh auth login`), and three keys:

| Variable | For |
| --- | --- |
| `BASETEN_API_KEY` | open models on Baseten Model APIs |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude models |
| `OPENAI_API_KEY` | the judge (`gpt-6.1-sol`, set in `configs/models.toml`); the key needs access to that model |

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -e .
pr-eval serve
```

`serve` opens http://127.0.0.1:8765. There you:

1. type a GitHub repository (or pick the sample: 42 merged PRs from 7 public repos),
2. choose how many pull requests (the most recent that change code and tests, up to 400 lines each) and which models to compare (Claude Opus 5.5 and DeepSeek V4.1 Flash to start),
3. press **Start run** and watch it go: finding PRs, checking them, then running each model. Stop and Resume are on the run.

When it finishes, **Open report** shows solve rate and cost per solved task side by side, with every attempt's diff, test output and the judge's reason. The checklist on the page says what's missing before you start: Docker, the GitHub login, or a key. The first run builds the Docker image, which takes a few minutes once.

Private repositories work through your own `gh` login. Go and Python repositories have default install and test commands. For anything else, open **Install and test commands** and say how, for example `npm ci` and `npx vitest run {test_files}`, where `{test_files}` becomes the PR's changed test files.

Before any model runs, each PR is checked in the same container the models use: its tests have to fail without the change and pass with it. PRs that don't are left out, because that's a setup problem, not the model's.

Where your code goes: the repository is cloned into `data/repos/` and each attempt works in a local Docker container. The code the agent reads goes to the model being tested (Anthropic or Baseten), and the diffs go to the judge (OpenAI). Nothing else leaves the machine.

On a Mac you can keep the Claude token in the Keychain instead of the environment: `security add-generic-password -a "$USER" -s pr-eval-claude-code-oauth-token -w`. Keys only ever come from the environment or the Keychain, never from files.

## From a terminal

The page runs this same command, so either works:

```bash
pr-eval run your-org/your-repo --limit 10 --models claude-opus,deepseek-v4.1-flash
pr-eval run                                   # the sample tasks instead (10 of them; --limit 42 for all)
```

It prints one line per attempt and keeps the report current. Stop it with Ctrl-C and continue with `pr-eval run --resume jobs/<run>`; the same command with `--attempts 3` adds attempts to a finished run, and with `--models kimi-k3` adds a model on the same tasks.

## How it works

1. **Collect.** Each merged PR becomes a task. The PR's text, or the issue it closes, is the request; the repository just before the merge is the starting point; the merged diff and the PR's tests are kept aside as the answer.
2. **Run.** Each attempt gets a fresh container. Claude Code works on the request with the model under test; open models on Baseten go through a small proxy in the container that sets the same reasoning effort on every request. GitHub, package registries and Claude Code's web tools are blocked while the agent works.
3. **Grade.** The agent's diff is saved, then the PR's hidden tests run against its code (its own test changes are set aside, so a test it wrote can't clash with the PR's), then an LLM judge compares its whole diff with the merged one and gives a one-sentence reason. Solved means the tests pass and the judge agrees.
4. **Report.** One HTML page per run, plus `report.json`: solve rate, cost per solved task, time and tokens, results by language, change size and repository, and every attempt's diff, test output and judge reason.

## What the numbers mean

- **Solve rate**: solved attempts / valid attempts. The 95% range is shown next to it; with a few dozen tasks, differences of a few points are noise.
- **Cost per solved task**: all spend on valid attempts / solved attempts, so a model that fails often pays for its failures. Judge tokens are not included.
- **Invalid attempts**: setup, provider, test-run or judge errors. Reported, never counted as failures.
- A merge date after a model's training cutoff makes memorization less likely, not impossible.

## Models

`configs/models.toml` lists the models `--models` can name: `claude-opus`, `glm-5.3`, `kimi-k3`, `muse-spark`, `deepseek-v4.1-flash`, `nemotron-3.5-super`. To add one, copy an entry and set its Baseten model id and prices. Every entry carries its own prices: Claude Code prices every model at Anthropic list rates, so open models are priced from the table, and Claude models take Claude Code's own figure.

## Commands

| Command | Does |
| --- | --- |
| `pr-eval serve` | the page: start runs, watch them, open their reports |
| `pr-eval run [owner/repo]` | find PRs, check them, run each model, grade and report (no repository: the sample tasks) |
| `pr-eval collect [owner/repo]` | only turn merged PRs into task folders in `tasks/` |
| `pr-eval report jobs/<run>` | rebuild a run's report |
| `pr-eval validate` | check task folders in the trial image without running a model |
| `pr-eval rejudge jobs/<run>` | grade a finished run again with another judge model |
| `pr-eval retest jobs/<run>` | rerun a finished run's hidden tests from its saved diffs (no model calls) |
| `pr-eval cleanup` | remove containers a killed run left behind |
| `pr-eval build-image` | rebuild the trial image, e.g. for another Claude Code version |

`pr-eval <command> --help` lists the options. `tasks/`, `jobs/` and `data/` are generated and gitignored: tasks carry the hidden tests and merged diffs, and jobs carry transcripts.

## Tests

```bash
python3 -m unittest discover -s tests     # no Docker, network or keys needed
```
