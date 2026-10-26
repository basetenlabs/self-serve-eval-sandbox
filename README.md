# self-serve-eval-sandbox

Check whether an open model can do your team's real coding work. `pr-eval` replays merged pull requests through Claude Code, once with a closed model and once with an open model, and reports how many tasks each solves and what each solved task costs.

Status: v0. Claude Code is the only harness.

Setting it up with a coding agent? Give it this repository's link and [SETUP.md](SETUP.md), a step-by-step guide with a check after each step.

## Quickstart

You need Python 3.12 to 3.14 (the Blaxel SDK does not install on 3.15 yet), the GitHub CLI (`gh auth login`), and a **new, dedicated Blaxel workspace** with capacity for 16 sandboxes at once: eight attempts, each with a grading sandbox that gets ready alongside it (`--concurrency` lowers that). The quick sample on the page starts all 20 of its attempts at once, so it needs 40. Create one in the [Blaxel console](https://app.blaxel.ai): click the workspace name at the bottom left, then **Switch** > **+**. No local Docker daemon is needed. Install the Blaxel CLI (runs use it to build and find the trial image), then sign in to that dedicated workspace. Do not use a main, shared or already-in-use workspace. Model calls and Blaxel compute incur charges.

One-time setup (replace `dedicated-eval-workspace` with the new workspace's name):

```bash
curl -fsSL https://blaxel.ai/install.sh | BL_INSTALL_SETUP=false sh
bl login dedicated-eval-workspace
mkdir -p ~/.config/pr-eval
printf '%s\n' '{"workspace":"dedicated-eval-workspace"}' > ~/.config/pr-eval/blaxel.json
```

Alternatively, set `PR_EVAL_BLAXEL_WORKSPACE` or pass `--workspace dedicated-eval-workspace` to `pr-eval serve` or a cloud command. The saved JSON contains only the workspace name, never credentials. There is no fallback to the CLI's current workspace, and `main` is rejected. Authentication uses your Blaxel login or `BL_API_KEY` from the environment. See the [Blaxel CLI install guide](https://docs.blaxel.ai/cli-reference/introduction).

You also need three provider keys:

| Variable | For |
| --- | --- |
| `BASETEN_API_KEY` | open models on Baseten Model APIs, and the Kimi K3 judge |
| `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude models, and the Claude Opus 5.5 judge (it runs through Claude Code, so `claude` must be installed) |
| `OPENAI_API_KEY` | the GPT-6.1 Sol judge |

The judges are a panel of three, set in `configs/models.toml`: Claude Opus 5.5, GPT-6.1 Sol and Kimi K3, each at high reasoning effort, each grading on its own. Kimi K3 then chairs: it reads the same evidence and all three verdicts and writes the final one.

```bash
python3.13 -m venv .venv && source .venv/bin/activate && pip install -e .  # or python3.12 or python3.14; includes the Blaxel Python SDK
pr-eval serve
```

`serve` opens http://127.0.0.1:8765. There you:

1. pick the **Quick sample** (10 merged PRs from 6 public repos, every attempt at once, a few minutes), or **Your pull requests**: paste pull request links, or type a repository and take its latest merges (the most recent that change code and tests, up to 400 lines each) or tick the ones you want from a list: type to find any merged PR by number, title or author (GitHub's search fills in the rest), and star the ones to keep, which come first next time,
2. choose which models to compare (Claude Opus 5.5 and DeepSeek V4.1 Flash to start),
3. press **Start run** and watch it go: finding PRs, checking them, then running each model. Stop and Resume are on the run.

When it finishes, **Open report** shows solve rate, cost per solved task and time per task side by side, with every attempt's diff, step-by-step trace, test output and the judges' verdicts. Any finished cell on the run's board opens that attempt. The checklist on the page says what's missing before you start: the dedicated Blaxel connection, build CLI, GitHub login, or a key. The first run builds the trial image remotely on Blaxel, which takes a few minutes once.

Private repositories work through your own `gh` login (the sample needs it too); on the hosted page, through **Sign in with GitHub**. Go and Python repositories have default install and test commands, which run the whole test suite; for grafana/grafana, too big for that, they run only the Go packages the PR's tests are in. For anything else, open **Install and test commands** and say how, for example `npm ci` and `npx vitest run {test_files}`, where `{test_files}` becomes the PR's changed test files. Changing the commands and starting again sets the PRs up afresh. The trial image has Go, Node and Python; another language's toolchain goes in `docker/Dockerfile`, and dependencies from a private registry need their access in the install command.

Before any model runs on a PR, the PR is checked in the same Blaxel image the models use: its tests have to fail without the change and pass with it. PRs that don't are left out, because that's a setup problem, not the model's. Each PR's attempts start as soon as its own check passes.

### Where your code goes

The repository clone stays in local `data/repos/`. Each attempt uploads its base snapshot and setup instructions to a fresh sandbox in your dedicated Blaxel workspace, and to a fresh verifier sandbox that gets ready at the same time; only after the agent stops and its sandbox is deleted are its diff and the hidden tests uploaded to the verifier for grading. Reference patches are uploaded only to separate task-validation sandboxes. The agent never shares a sandbox with the hidden answer. Execution artifacts are downloaded into local `jobs/`, and the page and HTML reports stay on this machine. Code the agent reads also goes to the model being tested (Anthropic or Baseten), and diffs go to the judges (Anthropic, OpenAI and Baseten). This is cloud execution, not local-only processing.

Sandboxes are deleted after use, including failed attempts. `--keep-sandboxes` retains verifier sandboxes for debugging; agent sandboxes are always deleted before hidden tests are uploaded. Ctrl-C or **Stop** cleans up that run's sandboxes. If the process is killed, use `pr-eval cleanup --workspace dedicated-eval-workspace`, optionally with `--run-id <run>`, to delete leftover eval sandboxes in that workspace. Cleanup does not delete other resources or the reusable trial image. Kept verifier sandboxes retain uploaded code and hidden tests until deleted; treat transcripts and local reports as sensitive too.

The sandbox uses Blaxel's enforced proxy firewall with a provider-only allowlist during agent execution, plus non-root API isolation. These firewall features are currently in public preview and run on Mark 3.0 infrastructure. Setup commands are trusted: they run with network access to install dependencies before the allowlist is narrowed. This does not defend against a malicious setup command that downloads the answer into the starting files or leaves an already-open network connection behind.

On a Mac you can keep the Claude token in the Keychain instead of the environment: `security add-generic-password -a "$USER" -s pr-eval-claude-code-oauth-token -w`. Keys only ever come from the environment or the Keychain, never from files.

## From a terminal

The page runs this same command, so either works:

```bash
pr-eval run your-org/your-repo --limit 10 --models claude-opus,deepseek-v4.1-flash
pr-eval run                                   # the sample tasks instead (10 of them; --limit 42 for all)
pr-eval run your-org/your-repo --pr 123 --pr 456   # exactly these PRs (up to 1,600 lines each)
pr-eval run https://github.com/o/a/pull/12 x/b#9    # or links to them, from any number of repositories
```

It prints one line per attempt and keeps the report current. Stop it with Ctrl-C and continue with `pr-eval run --resume jobs/<run>`; the same command with `--attempts 3` adds attempts to a finished run, and with `--models kimi-k3` adds a model on the same tasks. Resume also runs again any attempt lost to a sandbox, setup or provider problem (those never count against a model), and the page offers Resume on a finished run that has one. Resume restores the recorded Blaxel workspace, immutable image reference, region, sandbox size and judge (a tests-only run stays tests only), rather than switching to the current defaults. The default image name includes a hash of its build files; each run resolves that name to an immutable registry reference before validation. Old Docker runs remain readable as reports but cannot be resumed or retested on Blaxel: start a new run.

`--memory 4096` sets memory per sandbox in MiB (a repository that needs more gets it: grafana/grafana runs in 16384); `--region us-pdx-1` selects the Blaxel region, and `--concurrency 8` controls parallel attempts and checks. An upload or download that fails is tried once more before the attempt counts as a sandbox error. After changing `docker/Dockerfile`, run `pr-eval build-image`; validation is tied to the workspace and image identity so a rebuilt image is checked afresh.

## How it works

1. **Collect.** Each merged PR becomes a task. The PR's text, or the issue it closes, is the request; the repository just before the merge is the starting point; the merged diff and the PR's tests are kept aside as the answer. When those tests call something the PR added by name, or a function whose parameters it changed, the request lists those signatures (never the code), so a correct fix isn't failed for naming a helper differently.
2. **Run.** Each attempt gets a fresh Blaxel sandbox. Claude Code works on the request with the model under test; open models on Baseten go through a small proxy in the sandbox that sets the same reasoning effort on every request. GitHub, package registries and Claude Code's web tools are blocked while the agent works.
3. **Grade.** The agent's diff is saved and its sandbox deleted, then a fresh verifier sandbox, set up while the agent worked, runs the PR's hidden tests against its code (its own test changes are set aside, so a test it wrote can't clash with the PR's; the tests get a network of their own with only loopback, so one that serves on port 8080 doesn't collide with the sandbox's API), then a panel of three LLM judges each compares its whole diff with the merged one, and the chair weighs their reasons into one verdict with a one-sentence reason. Solved means the tests pass and the panel agrees. Binary files and caches such as `__pycache__` stay out of the diff the judges read.
4. **Report.** One HTML page per run, plus `report.json`: solve rate, cost per solved task, time and tokens, results by language, change size and repository, and every attempt's diff, test output and judge reason. On the page each attempt also has its trace: every command, file read and edit the agent made, with its output, condensed from `agent.jsonl` with anything shaped like a credential masked.

## What the numbers mean

- **Solve rate**: solved attempts / valid attempts. The 95% range is shown next to it; with a few dozen tasks, differences of a few points are noise.
- **Cost per solved task**: model spend on valid attempts / solved attempts, so a model that fails often pays for its failures. Judge tokens and Blaxel compute are not included.
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
| `pr-eval rejudge jobs/<run>` | grade a finished run again with the current panel (`--judge` for one of its judges) |
| `pr-eval retest jobs/<run>` | rerun a finished run's hidden tests from its saved diffs (no model calls) |
| `pr-eval cleanup` | remove eval sandboxes a killed run left behind in the dedicated workspace |
| `pr-eval build-image` | rebuild the trial image remotely on Blaxel, e.g. for another Claude Code version |

`pr-eval <command> --help` lists the options. `tasks/`, `jobs/` and `data/` are generated and gitignored: tasks carry the hidden tests and merged diffs, and jobs carry transcripts.

## Tests

```bash
python3 -m unittest discover -s tests     # no cloud, network or keys needed
cd web && npm run check                   # the page's type check and unit tests
```

## Changing the page

The page and the run report are a small React app in `web/`, built into two self-contained HTML files in `eval_sandbox/` that `pr-eval serve` and `pr-eval report` use as they are. Installing and running `pr-eval` needs no Node; changing the page does (Node 20.19 or 22.12 and later):

```bash
cd web
npm ci
npm run dev        # live reload at http://localhost:5173, against `pr-eval serve` on port 8765
npm run build      # writes eval_sandbox/app.html and eval_sandbox/report_template.html
```

Commit the built files with the source change. Each carries a hash of the sources it came from, and the unit tests fail when it doesn't match.
