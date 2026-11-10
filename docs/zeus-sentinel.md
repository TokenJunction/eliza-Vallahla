# Zeus Sentinel

Zeus runs every 3 hours on a GitHub-hosted runner. It checks the public site, asks the free OpenRouter models whether they answer, comments on open pull requests, and writes one status issue. If the site is still down after two retries, and only then, it can promote the deployment Wren last verified.

This costs nothing. It uses GitHub Actions and, when `OPENROUTER_API_KEY` is present, the existing `:free` models.

## What it must never do

- It must never merge a pull request.
- It must never push to main.
- It must never deploy new code, change DNS, or edit a wallet or trading path.
- It must never print a secret. It reads names from GitHub and does not write the values into the issue or the log.

A rollback is not a new deploy. It promotes `ZEUS_LAST_VERIFIED_DEPLOYMENT` for project `eliza-valhalla` on team `team_AsAJ3GVmfx8BxRUIQdEcZrgv` through `POST /v10/projects/eliza-valhalla/promote/{deploymentId}`. It does this at most once per run, and not again for 6 hours. The clock is a `rollback-at:` comment on the status issue. If that history cannot be read, or the token or deployment variable is missing, it skips the rollback and says so.

## Checks

- `https://valhalla-app.xyz/`, `https://www.valhalla-app.xyz/`, `https://valhalla-app.xyz/os/`, and `https://valos.live/` must return 200.
- `https://valhalla-app.xyz/api/ai` and `https://valhalla-app.xyz/api/feed` must return 401 while signed out. A 5xx is a failure.
- Each failure is retried twice, 30 seconds apart.
- The job exits non-zero only when the site is still down after healing, so GitHub can mail the failure.

## Names it reads

| Name | Kind |
| --- | --- |
| `OPENROUTER_API_KEY` | secret, optional |
| `VERCEL_TOKEN` | secret, optional |
| `ZEUS_LAST_VERIFIED_DEPLOYMENT` | repository variable, optional |
| `GITHUB_TOKEN` | provided by Actions |

No key belongs in this file or in the browser.
