# Valhalla social robot

This job posts one short note a day from `social/queue.yml`. It uses the X API v2 free tier. It does not promise profit.

The workflow file sets `DRY_RUN` to `true`. In that mode the job only writes the chosen post to the Actions summary. It does not call X.

## Secrets

Add these repository secrets. Do not put them in a file.

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`

The key and secret come from the X app. The access token and secret are the user tokens for the account that should post.

## Turn it on

1. Merge this workflow to `develop`. A daily schedule runs only from the default branch.
2. Confirm a dry run in the Actions summary.
3. Edit `.github/workflows/valhalla-social.yml` and set `DRY_RUN` to `"false"`.
4. The next run posts the note for that UTC day.

The note is `day of year` modulo 14, so the queue repeats every two weeks. Crypto is risky. The posts say so.
