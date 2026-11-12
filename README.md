# Self-Serve Model Eval Sandbox

Can an open model do your team's real coding work? `pr-eval` takes pull requests your team already merged and hands each one to Claude Code twice: once with a closed model, once with an open model. It grades both and reports how many tasks each model solves and what each solved task costs.

The command-line tool and the local page are both called `pr-eval`. Status: v0. Claude Code is the only harness. MIT licensed.

Trials run in [Baseten Sandboxes](https://docs.baseten.co/sandboxes/overview): each attempt works in a machine of its own, where the agent has no network and can reach only the model provider.

Setting it up with a coding agent? Give it this repository's link and [SETUP.md](SETUP.md), a step-by-step guide with a check after each step.

## What you need

- Python 3.12 or later.
- The GitHub CLI, signed in: `gh auth login`.
- Three provider keys, as environment variables:

| Variable | For |
| --- | --- |
| `BASETEN_API_KEY` | the sandboxes attempts run in, open models on Baseten Model APIs, and the Kimi K3 judge |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude models, and the Claude Opus 5.5 judge (install `claude` too) |
| `OPENAI_API_KEY` | the GPT-6.1 Sol judge |

The Baseten key has to be one that can create sandboxes: a personal key, or a team creator service account key. To keep a model-only key in `BASETEN_API_KEY`, put the other in `BASETEN_SANDBOX_API_KEY`. `BASETEN_TEAM_ID` pins the team the sandboxes go in: with it set, a key that can't reach that team is refused instead of running somewhere else. There is no other account to make, no CLI to install and no local Docker.

An attempt uses two sandboxes at once, one for the agent and one for grading, and the quick sample runs 20 attempts together. Baseten runs [10 sandboxes at once](https://docs.baseten.co/sandboxes/manage) for an organization until you ask for more. When the count is full, a new sandbox waits for one to finish, so set `--concurrency` to a quarter of your limit until it is raised.

Model calls and sandbox compute cost money. The quick sample costs about $12.

## Quickstart

Install and start the page:

```bash
git clone https://github.com/basetenlabs/self-serve-eval-sandbox.git && cd self-serve-eval-sandbox
python3.13 -m venv .venv && source .venv/bin/activate && pip install -e .
pr-eval serve
```

It opens http://127.0.0.1:8765, with a checklist of anything still missing. Then:

1. Pick the **Quick sample** (10 merged PRs from PostHog's Python codebase, about 35 minutes) or **Your pull requests**: paste links, or type a repository and pick from its merges.
2. Choose the models to compare (Claude Opus 5.5, DeepSeek V4.1 Flash 1017 Fast and GLM-5.3 Fast to start).
3. Press **Start run**. When it finishes, **Open report** shows solve rate, cost per solved task and time per task, with every attempt's diff, trace, test output and the judges' verdicts.

The first run builds the trial image on Baseten, which takes a few minutes once. Private repositories work through your `gh` login.

Go and Python repositories have default install and test commands. For anything else, open **Install and test commands** and say how, for example `npm ci` and `npx vitest run {test_files}`. The trial image has Go, Node and Python; add other toolchains in `docker/Dockerfile`.

## From a terminal

The page runs this same command:

```bash
pr-eval run your-org/your-repo --limit 10 --models claude-opus,deepseek-v4.1-flash-1017-fast,glm-5.3-fast
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
| `pr-eval cleanup` | remove sandboxes a killed run on this machine left behind |
| `pr-eval build-image` | rebuild the trial image on Baseten |

## Where your code goes

- The repository clone stays on your machine, in `data/repos/`, and each pull request's task (its code, merged diff and tests) in `tasks/`. A private repository's clone and tasks are deleted when its last run ends, or, if that run's process died, when `pr-eval serve` or `pr-eval run` next starts. The run's report and results stay; resuming collects the tasks again.
- Each attempt runs in a fresh sandbox on Baseten, in your key's team, starting from the repository as it was before the merge. Inside it, the agent and everything it starts run in a jail with no network: no GitHub, no package registries, no web tools. Its one way out is a relay beside it in the sandbox, which sends its calls to the model provider and nowhere else.
- The agent never holds a model key. It signs in with a placeholder, and the relay, a process it can't see or read, puts the key on each call. The relay ends, and the key with it, when the agent stops.
- When the agent stops, its sandbox is deleted. Only then do its diff and the PR's hidden tests go to a separate sandbox for grading. The agent never sees the answer.
- Code the agent reads goes to the model being tested (Anthropic or Baseten). Diffs go to the judges (Anthropic, OpenAI and Baseten).
- Transcripts and reports are saved locally in `jobs/`. Treat them as sensitive. Set `PR_EVAL_PRIVATE_RETENTION_DAYS` to delete a private repository's run transcripts that many days after the run ends.
- Sandboxes are deleted after use, and delete themselves six hours after they were made whatever became of the run. If the process is killed, `pr-eval cleanup` removes what this machine's runs left. A team's sandboxes are shared, so pr-eval only ever deletes ones it labelled for a run on this machine.
- Setup commands are trusted: they run with network access, before the agent starts.
- Keys come only from the environment (or, for the Claude token, the macOS Keychain; see [SETUP.md](SETUP.md)), never from files.

## How it works

1. **Collect.** Each merged PR becomes a task. The PR's text, or the issue it closes, is the request. The merged diff and the PR's tests are kept aside as the answer. Before any model runs, the PR's tests must fail without the change and pass with it, and the chair judge checks that the request says enough to pass them (the text is often written before the PR's final code); PRs that fail either check are left out. If the judge can't be reached, the task goes ahead on its tests alone. A test that can't import a name the request never gives makes the attempt not scored, not a model failure.
2. **Run.** Claude Code works on the request with the model under test. Its calls go through a small relay in the sandbox; for open models on Baseten, the relay also sets the same reasoning effort on every request.
3. **Grade.** The PR's hidden tests run against the agent's code. Then three LLM judges (Claude Opus 5.5, GPT-6.1 Sol and Kimi K3) each compare its diff with the merged one, and Kimi K3 writes the final verdict. Solved means the tests pass and the final verdict is a pass. If the chair can't answer, a unanimous panel decides.
4. **Report.** One HTML page per run, plus `report.json`.

## What the numbers mean

- **Solve rate**: solved attempts / valid attempts, with a 95% range. With a few dozen tasks, a few points' difference is noise.
- **Cost per solved task**: model spend / solved attempts, so a model that fails often pays for its failures. Judges and sandbox compute aren't included.
- **Invalid attempts**: setup, provider, test or judge errors. Reported, never counted as failures.
- A merge date after a model's training cutoff makes memorization less likely, not impossible.

## Models

`configs/models.toml` lists the models and their prices: `claude-opus`, `glm-5.3`, `glm-5.3-fast`, `kimi-k3`, `kimi-k3.1-pro`, `muse-spark`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017-fast`, `nemotron-3.5-super`. To add one, copy an entry and set its Baseten model id and prices; `estimate_from` lists models whose past runs estimate a new one's cost and time until it has its own.

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

`hosted/` deploys Baseten's hosted copy of the page. It depends on Blaxel's sign-in package, which isn't public, and you don't need it to run pr-eval.
