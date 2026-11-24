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
  admin, an invited address (any domain, Gmail too) or at exactly one of the internal domains (never a
  subdomain). Outside people get in one email address at a time: no request, approval or admin
  change adds a whole domain. The first start creates the file with
  the admins in `PR_EVAL_ADMINS` (comma-separated emails, set when deploying) and the domains
  baseten.co and blaxel.ai; `deploy.py` never overwrites it.
  Signed-in staff at either internal domain can request access for one email address from
  **Access**. They give a reason and see the outcome for their own requests. Each person may submit
  five requests per hour. Admins can revoke access and manage internal admins.
  Set `PR_EVAL_ACCESS_OWNER` at deploy time to one existing admin's verified email to enable
  **Add directly** for that person when the approval worker is unavailable. Leave it unset to
  disable direct grants. Changing the setting takes effect on the next deploy.
  Removing an entry asks for confirmation. For a domain, the dialog counts distinct signed-in
  addresses seen on the page since tracking began. The sign-in server keeps the domain and an
  address digest in `AUTH_STATE_DIR/visitors.sqlite`. Admins receive only the domain totals.
- **Approval:** the sign-in server stores pending requests beside the lists in `data/access.json`.
  The approval worker polls `GET /api/worker/access-requests` with a dedicated bearer token, then
  posts `{id, status, decidedBy}` to the same path. The first decision wins. The sign-in server saves
  the decision, approver, method (`worker` or `direct`), timestamp and any grant in one atomic
  replacement. A direct grant approves matching pending requests or creates an approved entry
  with the owner's verified email. Older decisions without a method came from the worker. Sign-in reads the new
  list on the next request. The deploy gives only the sign-in process `PR_EVAL_ACCESS_TOKEN` from
  the Mac Keychain item `pr-eval-host-access-token`. Without it, new submissions and worker access
  are disabled. Requests wait while the worker is offline.
- **Keys:** the page's process gets the judges' and models' keys, and the Baseten key its runs
  create their sandboxes with, in its environment when it starts. They are never written to the
  volume, the image or this repository.
- **Key meter:** trial sandboxes never get a model key, and hosted the agent can't reach a provider
  either: its one destination is the meter, a second public preview ("meter") served by
  the page's process (`eval_sandbox/meter.py`). The agent runs in a jail with no network
  (`docker/jail.py`); the attempt's model relay, beside it in the sandbox and out of its sight
  (`docker/proxy.py`), puts the attempt's ticket on each request and sends it to the meter. The
  meter checks the ticket, adds the real key, forwards the call and writes what its usage
  cost to the run's `spend.jsonl`. So a call made by the repository's code during an attempt counts
  like the agent's own. It refuses a call with no live ticket, from a run with no owner or one
  stopped for spending, for another provider, for a model with no price, or to an endpoint whose
  usage it can't read. A ticket ends when its attempt's agent stops.
- **GitHub:** the hosted page runs public repositories only, and nobody signs in with GitHub. It
  reads them with its own fine-grained token, which can read public repositories only
  (`PR_EVAL_GITHUB_TOKEN`, from the Keychain item `pr-eval-host-github-token`; create it on
  GitHub with "Public repositories" access and no permissions), and refuses a private repository
  even if that token could read it. Without that token, the page runs the quick sample only. The
  quick sample's task folders are on the volume (`deploy.py` copies the missing ones), and its runs
  only read them. Private repositories are for running pr-eval yourself, where your own `gh` login
  reads them.
- **Who sees a run:** people signed in with a baseten.co or blaxel.ai address can open runs started
  by anyone at either domain, including runs on private repositories. The run list names the starter.
  Guests see only their own runs. Admins see every run, including older runs without a recorded owner.
  Only the starter and admins can stop or resume a hosted run. The starter is recorded in the run's
  `access.json` on the volume.
- **Saved pull requests:** each person's stars, kept on the volume in `data/favorites.json`.
- **Runs:** everything is on Baseten Sandboxes, in one team: the page's sandbox, and the trial
  sandboxes its runs create with the deploy's own key (`BASETEN_SANDBOX_API_KEY`, and
  `BASETEN_TEAM_ID` when set). Nobody who uses the page connects an account or a workspace, and
  nobody's run depends on anyone's quota but the team's. That key can manage every sandbox in its
  team, so the page's process holds it and no trial sandbox ever does; where other tools share the
  team, the runs delete only sandboxes they labelled themselves. Baseten Sandboxes can't limit a
  sandbox's network yet, so a trial does it from inside: it installs dependencies with the network
  open, then the agent, and the hidden tests after it, run in a jail with none. The team's sandbox
  count is shared by every run: when it is full, a new sandbox waits for one to finish. While a
  run is going, the sign-in server keeps the page's sandbox awake.
- **Limits:** up to 20 runs go at once, three per person, and two runs never share a repository (both
  would clone it and check its pull requests at once), except quick samples. However many go, they
  share the page's places: 40 attempts at once in all (about 80 sandboxes) and 4 Claude Code judges.
  Each next free place goes to the run holding the fewest, so a small run started beside a big one
  starts at once; the rest of a run's attempts wait their turn. Runs in
  the last 24 hours may spend $1,000 in all and $500 per person on models. Each run keeps a
  ledger (`spend.jsonl`) of every model call it pays for, written as each finishes: every call
  through the key meter, including from attempts that ended invalid, were stopped or run again on
  resume, and every judge's answer. The limits add up the entries from the last 24 hours, by when each was spent,
  so a run resumed days later counts too. Sandbox compute isn't included. A charge with no price
  never counts as free: an agent attempt counts its model's latest cost per attempt (else $5,
  or the dearest attempt seen if more), a judge's answer $0.25. A run (or a resume) whose estimate
  would go over waits, counting what the runs already going are still expected to spend (each run's
  estimate when it started, less what it has spent since); a run going stops (resumable) within 30 seconds
  once its owner or the page reaches the limit, and the attempts it had going still count, so a person can
  end a little over. Set them with `PR_EVAL_MAX_RUNS`, `PR_EVAL_RUNS_PER_PERSON`,
  `PR_EVAL_ATTEMPTS_AT_ONCE`, `PR_EVAL_JUDGES_AT_ONCE`, `PR_EVAL_SPEND_TOTAL` and
  `PR_EVAL_SPEND_PER_PERSON` when deploying; locally a run at a time, no shared places and no spending limit.
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
   task (a PostHog pull request, a ~222 MB source) with the cheapest default model (DeepSeek V4.1 Flash
   1017), in one try, graded on its hidden tests as the page's runs are. Its sandboxes start, the source
   uploads, the dependencies install, the agent changes code (it stops at 6 minutes, as at any time limit)
   and the hidden tests run on that change; whether the model solved it doesn't matter. On a fail, the page stays on its release and the deploy exits 1
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

Then delete the Keychain items `deploy.py` reads its keys from (`SECRETS` in that file).
