# Hosted eval page

The deployment behind Baseten's hosted copy of the eval page: the same page as `pr-eval serve`, on
a Baseten sandbox, behind a sign-in, for people who don't want to install anything. You don't need
any of this to run pr-eval yourself. Its sign-in package, Blaxel's `@blaxel-ai/sign-in` (installed as
`@blaxel/sign-in`), isn't public, so this folder can't be deployed outside Baseten as it is.

- **Sign-in:** `server.mjs` is the only public door: "Sign in with Blaxel" in front of
  `pr-eval serve` on 127.0.0.1. The page learns who is
  asking only from `X-Forwarded-Email`, which the sign-in server sets after dropping whatever the
  browser sent. A request that starts or stops a run must come from the site itself, and the page
  logs who sent it.
- **Who may sign in:** the people `data/access.json` on the volume lists:
  `{"admins": [], "emails": [], "domains": []}`. A verified Blaxel email gets in when it is an
  admin, an invited address (any domain, Gmail too) or at exactly one of the domains (never a
  subdomain; public mail domains and wildcards are refused). The first start creates the file with
  the admins in `PR_EVAL_ADMINS` (comma-separated emails, set when deploying) and the domains
  baseten.co and blaxel.ai; `deploy.py` never overwrites it.
  Admins change it on the page's **Access** tab, which only they see. The sign-in server answers
  that tab (`access.mjs`): it checks the person is an admin in the file as it is now on every
  request, checks each entry with the sign-in's own rules, never removes the last admin, writes the
  file atomically and logs who changed what. The sign-in re-reads the file on every change, so
  someone removed is signed out on their next request.
- **Keys:** the page's process gets the judges', models' and Blaxel keys in its environment
  when it starts. They are never written to the volume, the image or this repository.
- **Key meter:** trial sandboxes never get a model key, and hosted they can't reach a provider
  either: their one destination is the meter, a second public preview ("meter") served by
  the page's process (`eval_sandbox/meter.py`). Blaxel's egress proxy puts the attempt's ticket on
  each request; the meter checks it, adds the real key, forwards the call and writes what its usage
  cost to the run's `spend.jsonl`. So a call made by the repository's code during an attempt counts
  like the agent's own. It refuses a call with no live ticket, from a run with no owner or one
  stopped for spending, for another provider, for a model with no price, or to an endpoint whose
  usage it can't read. A ticket ends when its attempt's agent stops.
- **GitHub:** public repositories and the quick sample need no GitHub sign-in. The page reads
  public repositories with its own fine-grained token, which can read public repositories only
  (`PR_EVAL_GITHUB_TOKEN`, from the Keychain item `pr-eval-host-github-token`; create it on
  GitHub with "Public repositories" access and no permissions). Without that token, every run but
  the quick sample needs the person's own GitHub sign-in. The quick sample's task folders are on
  the volume (`deploy.py` copies the missing ones), and its runs only read them. A run on a private
  repository needs the person's own **Sign in with GitHub**: GitHub's device flow through
  the GitHub App [Baseten Eval Sandbox](https://github.com/apps/baseten-eval-sandbox)
  (read-only Contents, Pull requests and Metadata; no webhooks; its client id is in `deploy.py`,
  and the page needs no secret). Private repositories need the app added to them: a
  repository it can't read yet shows **Add it on GitHub**, and the page looks again when they
  come back. Their token lives in the page's memory
  only, for 8 hours or until they sign out or the page restarts, and their runs clone with it. In
  an organization, an owner installs the app, or approves the person's request to.
- **Who sees a run:** only the person who started it, on a public repository too, and the admins,
  who see every run, with who started it, and can open any. The page records the starter in
  `access.json` in the run's folder, and hides a run with no owner recorded from everyone else. The
  runs, their logs and the log lines naming who started or stopped one all stay on the volume.
- **Saved pull requests:** each person's stars, kept on the volume in `data/favorites.json`.
- **Runs:** the page's sandbox is on Baseten Sandboxes; its trials still run on Blaxel, in the same
  dedicated workspace as local runs: `deploy.py` reads it from `PR_EVAL_BLAXEL_WORKSPACE`, else
  `~/.config/pr-eval/blaxel.json`, and stops if neither is set. Trials stay on Blaxel for now:
  a trial installs dependencies with the network open, then the agent runs with model-provider-only
  egress, and that per-phase network policy is what Blaxel sandboxes provide today. While a run is going, the sign-in server
  keeps the sandbox awake.
- **Limits:** two runs go at once, one per person, and two runs never share a repository (both
  would clone it and check its pull requests at once), except two quick samples. Runs in
  the last 24 hours may spend $1,000 in all and $500 per person on models. Each run keeps a
  ledger (`spend.jsonl`) of every model call it pays for, written as each finishes: every call
  through the key meter, including from attempts that ended invalid, were stopped or run again on
  resume, and every judge's answer. The limits add up the entries from the last 24 hours, by when each was spent,
  so a run resumed days later counts too. Blaxel compute isn't included. A charge with no price
  never counts as free: an agent attempt counts its model's latest cost per attempt (else $5,
  or the dearest attempt seen if more), a judge's answer $0.25. A run (or a resume) whose estimate
  would go over waits; a run going stops (resumable) within 30 seconds once its owner or the page
  reaches the limit, and the attempts it had going still count, so a person can end a little over. Set them with
  `PR_EVAL_MAX_RUNS`, `PR_EVAL_RUNS_PER_PERSON`, `PR_EVAL_SPEND_TOTAL` and
  `PR_EVAL_SPEND_PER_PERSON` when deploying; locally a run at a time and no spending limit.
- **Private repositories:** a run's clone and task folders go when it ends (its report and results
  stay). With `PR_EVAL_PRIVATE_RETENTION_DAYS` set when deploying, a private run's transcripts go
  that many days after it ends; unset keeps them.

## Deploy

```sh
(cd hosted && NODE_AUTH_TOKEN="$(gh auth token)" npm ci)                    # @blaxel/sign-in, from GitHub Packages
.venv/bin/python hosted/deploy.py --seed jobs/<run>                          # create or update
.venv/bin/python hosted/deploy.py --renew                                    # daily: Baseten deletes a sandbox at 7 days
```

The deploy manages the sandbox with a Baseten key that can mint sandbox tokens (a personal key or a
team creator service account key; `BASETEN_SANDBOX_API_KEY`, else the Keychain item in `SANDBOX_KEY`).
It builds the image from `hosted/Dockerfile` on Baseten when that exact file isn't built yet. The
site's address is a random Baseten preview host that the deploy prints. Baseten deletes every sandbox 7
days after it was created, whatever its lifecycle policy says: `--renew` recreates it once it is 5
days old and no run is going (runs, access list and sign-in state stay on the volume). A recreated
sandbox can get a new address; the deploy prints it, and the sign-in registers itself for it.

`npm ci` needs a GitHub token that can read packages (`gh auth refresh -h github.com -s read:packages`)
and npm pointed at it once per machine, never written into a file:
`npm config set '//npm.pkg.github.com/:_authToken' '${NODE_AUTH_TOKEN}'`. The release carries the
installed package, so the sandbox needs no token.

To try a release before the live page gets it, deploy a copy beside it:
`.venv/bin/python hosted/deploy.py --name pr-eval-staging` has its own sandbox, volume, sign-in and
preview; `--name pr-eval-staging --delete --volume` removes it.

`deploy.py` reads the keys from the macOS Keychain or the environment (the list is at the top of
the file), creates the image, volume, sandbox and public previews when they don't exist yet, and uploads the
app as a new release, in a folder of its own (`/data/app/releases/<time>-<commit>`; runs, tasks and data
stay shared in `/data/app`). Then it ships the release only if it works end to end:

1. **Smoke test before release.** The release's own page and key meter start beside the live ones (a
   second meter preview, "meter-next"), and one real attempt runs from it: the quick sample's largest
   task (a PostHog pull request, a ~207 MB source) with the cheapest default model (DeepSeek V4.1 Flash
   1017 Fast), graded by the default judges. Its sandboxes start, the source uploads, the dependencies
   install, the agent changes code (it stops at 6 minutes, as at any time limit), the hidden tests run on
   that change and the judges answer; whether the model solved it doesn't matter. On a fail, the page stays on its release and the deploy exits 1
   with the attempt's cause.
2. **Switch.** `/data/app/current` points at the release, both processes restart on it, and the deploy
   checks the signed-out answers (sign-in page 200, page 303, API 401, meter 401).
3. **Smoke test after release,** the same attempt through the live meter. On a fail, or a failed check
   in step 2, the deploy rolls back to the previous release, restarts on it and exits 1.

Each smoke test takes about 9 minutes and about $0.75 of model calls (the deploy prints both), so a deploy
takes about 17 minutes more than it used to. The smoke runs are in `jobs/smoke-*` on the volume with
their logs; the page lists them nowhere and leaves them out of its limits. A deploy that goes live removes
all but the newest six.

A deploy never stops a run going. Each run is a process of its own (`pr-eval run`) that outlives the
page's restart, and it keeps running the release it started from: the deploy removes an old release only
once no process runs from it, and keeps the newest three. The restarted page finds a run going by the
process id in its `run.json` and shows it going; its attempts' model calls reach the restarted meter, which
reads the same tickets from the volume. `--seed` copies finished runs' summaries (run.json, report.json, report.html, and each
trial's result.json and condensed, redacted trace, all scanned for credentials first); full
transcripts stay on your machine. A sandbox keeps the image it was created from: after a new
image, `deploy.py --delete` and deploy again (runs and sign-in state stay on the volume).

## Remove

```sh
.venv/bin/python hosted/deploy.py --delete            # the sandbox; runs and sign-in state stay on the volume
.venv/bin/python hosted/deploy.py --delete --volume   # everything
```

Then delete the Blaxel service account the page's trials used, in the workspace's settings, and the
Keychain items `deploy.py` reads its keys from (`SECRETS` in that file).
