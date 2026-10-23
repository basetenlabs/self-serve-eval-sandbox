# Hosted eval page

The same page as `pr-eval serve`, on a Blaxel sandbox, for people who don't want to install
anything. Anyone whose Blaxel account has a verified `@baseten.co` or `@blaxel.ai` email can
sign in, start runs and read reports.

- **Sign-in:** `gateway.mjs` is the only public door. It serves "Sign in with Blaxel" (OAuth code
  flow with PKCE; `auth.mjs` and `oidc.mjs` are vendored from Benchmark Studio, and the sign-in
  page uses the eval page's Baseten style and fonts) and passes signed-in requests to
  `pr-eval serve` on 127.0.0.1. A request that starts or stops a run must come from the site
  itself, and the gateway logs who sent it.
- **Keys:** the page's process gets the judge, model, GitHub and Blaxel keys in its environment
  when it starts. They are never written to the volume, the image or this repository.
- **Public repositories only:** everyone signed in shares one GitHub login, so the hosted page
  refuses private repositories (`PR_EVAL_PUBLIC_REPOS_ONLY`).
- **Runs:** trials run in the same dedicated workspace as local runs (`pr-eval-01db4d88`). While a
  run is going, the gateway keeps the sandbox awake.

## Deploy

```sh
bl push -d hosted --name pr-eval-host --type sandbox -w pr-eval-01db4d88   # the image, once
.venv/bin/python hosted/deploy.py --seed jobs/grafana-1021                   # create or update
```

`deploy.py` reads the keys from the environment or the macOS Keychain (the list is at the top of
the file), creates the volume, sandbox and public preview when they don't exist yet, uploads the
app, restarts both processes and checks the signed-out answers (sign-in page 200, page 303, API
401). `--seed` copies finished runs' summaries (run.json, report.json, report.html, and each
trial's result.json and condensed, redacted trace, all scanned for credentials first); full
transcripts stay on your Mac.

Logs: `bl logs sandbox pr-eval-host -w pr-eval-01db4d88`.

## Remove

```sh
.venv/bin/python hosted/deploy.py --delete            # the sandbox; runs and sign-in state stay on the volume
.venv/bin/python hosted/deploy.py --delete --volume   # everything
```

Then delete the `pr-eval-host` service account in the workspace's settings, and the
`pr-eval-host-blaxel-api-key` Keychain item (`security delete-generic-password -s pr-eval-host-blaxel-api-key`).
