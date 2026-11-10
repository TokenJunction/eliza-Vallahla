# Zeus Sentinel

Zeus runs every 3 hours on a GitHub-hosted runner. It checks the public site, asks the free OpenRouter models whether they answer, and comments on open pull requests. If the site is still down after two retries, and only then, it can promote the deployment Wren last verified.

This costs nothing. It uses GitHub Actions and, when `OPENROUTER_API_KEY` is present, the existing `:free` models.

Issues are disabled on this repository. Zeus does not open or pin an issue. The human-readable report is the job summary. The rollback clock is a commit-free file, `.zeus-state/state.json`, stored only in this workflow's Actions cache. A new run uses a fresh cache key, and `restore-keys` brings back the newest `zeus-state-` entry. The exact key never matches, so the restored file, not `cache-hit`, is what counts. Zeus does not read or write repository artifacts: another workflow can upload the same artifact name, and the artifact list is not ordered by time. The GitHub token used here cannot update repository variables, so `ZEUS_LAST_ROLLBACK_AT` is not written.

## What it must never do

- It must never merge a pull request.
- It must never push to main.
- It must never deploy new code, change DNS, or edit a wallet or trading path.
- It must never print a secret. It reads names from GitHub and does not write the values into the summary or the log.
- If the rollback clock cannot be read or written, it reports and does not promote.

A rollback is not a new deploy. It promotes `ZEUS_LAST_VERIFIED_DEPLOYMENT` for project `eliza-valhalla` on team `team_AsAJ3GVmfx8BxRUIQdEcZrgv` through `POST /v10/projects/eliza-valhalla/promote/{deploymentId}`. A response outside 200–299 is a failed heal. Health checks run again either way. The clock moves only after it has been saved, and a failed promote puts the previous time back. It does this at most once per run, and not again for 6 hours.

`VERCEL_TOKEN` should be scoped to the `eliza-valhalla` project. The current operations token expires on December 10, 2026. Zeus reads it only from the Actions secret. It is not written into the repository.

## Checks

- `https://valhalla-app.xyz/`, `https://www.valhalla-app.xyz/`, `https://valhalla-app.xyz/os/`, and `https://valos.live/` must return 200.
- `https://valhalla-app.xyz/api/ai` is healthy on 401 or 405. The current route answers GET with 405 before sign-in, and 401 is still accepted. `https://valhalla-app.xyz/api/feed` must return 401 while signed out. A 5xx is a failure. Any other status is a failure.
- Each request aborts after 20 seconds. Each failure is retried twice, 30 seconds apart.
- The job exits non-zero only when the site is still down after healing, so GitHub can mail the failure.

## Names it reads

| Name | Kind |
| --- | --- |
| `OPENROUTER_API_KEY` | secret, optional |
| `VERCEL_TOKEN` | secret, optional, project-scoped, current ops token expires December 10, 2026 |
| `ZEUS_LAST_VERIFIED_DEPLOYMENT` | repository variable, optional |
| `GITHUB_TOKEN` | provided by Actions, used for pull request comments and the cache |

No key belongs in this file or in the browser.
