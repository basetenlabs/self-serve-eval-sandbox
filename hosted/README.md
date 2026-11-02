# Hosted eval page

The deployment behind Baseten's hosted copy of the eval page: the same page as `pr-eval serve`, on
a Blaxel sandbox, behind a sign-in, for people who don't want to install anything. You don't need
any of this to run pr-eval yourself. Its sign-in package, `@blaxel/sign-in`, isn't public, so this
folder can't be deployed outside Baseten as it is.

- **Sign-in:** `server.mjs` is the only public door: "Sign in with Blaxel" in front of
  `pr-eval serve` on 127.0.0.1. The page learns who is
  asking only from `X-Forwarded-Email`, which the sign-in server sets after dropping whatever the
  browser sent. A request that starts or stops a run must come from the site itself, and the page
  logs who sent it.
- **Who may sign in:** the people `data/access.json` on the volume lists:
  `{"admins": [], "emails": [], "domains": []}`. A verified Blaxel email gets in when it is an
  admin, an invited address (any domain, Gmail too) or at exactly one of the domains (never a
  subdomain; public mail domains and wildcards are refused). The first start creates the file with
  two admins (michael.stolarz@baseten.co, mstolarz@blaxel.ai) and the domains baseten.co and
  blaxel.ai, so everyone who could sign in before still can; `deploy.py` never overwrites it.
  Admins change it on the page's **Access** tab, which only they see. The sign-in server answers
  that tab (`access.mjs`): it checks the person is an admin in the file as it is now on every
  request, checks each entry with the sign-in's own rules, never removes the last admin, writes the
  file atomically and logs who changed what. The sign-in re-reads the file on every change, so
  someone removed is signed out on their next request.
- **Keys:** the page's process gets the judges', models', GitHub and Blaxel keys in its environment
  when it starts. They are never written to the volume, the image or this repository.
- **GitHub:** the page's own GitHub login, shared by everyone, reads public repositories only
  (`PR_EVAL_PUBLIC_REPOS_ONLY`). For private ones, people **Sign in with GitHub** on the page:
  GitHub's device flow through the GitHub App [Baseten Eval Sandbox](https://github.com/apps/baseten-eval-sandbox)
  (read-only Contents, Pull requests and Metadata; no webhooks; its client id is in `deploy.py`,
  and the page needs no secret). It reads only the repositories each person adds to it: a
  repository it can't read yet shows **Add it on GitHub**, and the page looks again when they
  come back. Their token lives in the page's memory
  only, for 8 hours or until they sign out or the page restarts, and their runs clone with it. In
  an organization, an owner installs the app, or approves the person's request to.
- **Who sees a run:** only the person who started it, on a public repository too, and the admins,
  who see every run, with who started it, and can open any. The page records the starter in
  `access.json` in the run's folder, and hides a run with no owner recorded from everyone else. The
  runs, their logs and the log lines naming who started or stopped one all stay on the volume.
- **Saved pull requests:** each person's stars, kept on the volume in `data/favorites.json`.
- **Runs:** trials run in the same dedicated workspace as local runs, and the page's sandbox lives
  there too: `deploy.py` reads it from `PR_EVAL_BLAXEL_WORKSPACE`, else `~/.config/pr-eval/blaxel.json`,
  and stops if neither is set. While a run is going, the sign-in server keeps the sandbox awake.
- **Limits:** two runs go at once, one per person, and two runs never share a repository (both
  would clone it and check its pull requests at once), except two quick samples. Runs started in
  the last 24 hours may cost $300 in all and $50 per person (the agents' cost as reports count it;
  judges and Blaxel aren't included). A run whose estimate would go over waits; a model no
  earlier run priced counts $5 an attempt, or the dearest attempt seen if more. A run going
  stops (resumable) once its owner or the page reaches the limit. Set them with
  `PR_EVAL_MAX_RUNS`, `PR_EVAL_RUNS_PER_PERSON`, `PR_EVAL_SPEND_TOTAL` and
  `PR_EVAL_SPEND_PER_PERSON` when deploying; locally a run at a time and no spending limit.
- **Private repositories:** a run's clone and task folders go when it ends (its report and results
  stay). With `PR_EVAL_PRIVATE_RETENTION_DAYS` set when deploying, a private run's transcripts go
  that many days after it ends; unset keeps them.

## Deploy

```sh
bl push -d hosted --name pr-eval-host --type sandbox -w <workspace>        # the image, once and after changing hosted/Dockerfile
(cd hosted && NODE_AUTH_TOKEN="$(gh auth token)" npm ci)                    # @blaxel/sign-in, from GitHub Packages
.venv/bin/python hosted/deploy.py --seed jobs/<run>                          # create or update
```

`npm ci` needs a GitHub token that can read packages (`gh auth refresh -h github.com -s read:packages`)
and npm pointed at it once per machine, never written into a file:
`npm config set '//npm.pkg.github.com/:_authToken' '${NODE_AUTH_TOKEN}'`. The release carries the
installed package, so the sandbox needs no token.

To try a release before the live page gets it, deploy a copy beside it:
`.venv/bin/python hosted/deploy.py --name pr-eval-staging` has its own sandbox, volume, sign-in and
preview; `--name pr-eval-staging --delete --volume` removes it.

`deploy.py` reads the keys from the macOS Keychain or the environment (the list is at the top of
the file), creates the volume, sandbox and public preview when they don't exist yet, uploads the
app, restarts both processes and checks the signed-out answers (sign-in page 200, page 303, API
401). `--seed` copies finished runs' summaries (run.json, report.json, report.html, and each
trial's result.json and condensed, redacted trace, all scanned for credentials first); full
transcripts stay on your Mac. A sandbox keeps the image it was created from: after a new
image, `deploy.py --delete` and deploy again (runs and sign-in state stay on the volume).

Logs: `bl logs sandbox pr-eval-host -w <workspace>`.

## Remove

```sh
.venv/bin/python hosted/deploy.py --delete            # the sandbox; runs and sign-in state stay on the volume
.venv/bin/python hosted/deploy.py --delete --volume   # everything
```

Then delete the Blaxel service account the deploy used, in the workspace's settings, and the
Keychain items `deploy.py` reads its keys from (`SECRETS` in that file).
