# Valhalla sign-in Worker

This Worker checks a Google ID token and sends a 6-digit email code. It does not hold wallet keys. It does not send or move funds.

The same files are on the `docs/site` branch under `workers/`. The website reads `AUTH_URL` in `site-config.js`. Leave that empty until this Worker is deployed.

## Secrets

Set these in Cloudflare. Do not commit them.

- `GOOGLE_CLIENT_ID` — the same public client id as the website. Scopes stay openid, email, and profile.
- `DEVICE_COOKIE_SECRET` — a long random string. It signs the 30-day device cookie and the session token.
- `ADMIN_WALLETS` — leader public keys, comma-separated. A leader always needs the email code.
- `RESEND_API_KEY` — only if Cloudflare Email Sending is not ready.
- `AUTH_KV` — the KV namespace id in `auth.toml`.

## Email

Use Cloudflare Email Sending on the `valhalla-app.xyz` zone when it is onboarded. The sender is `noreply@valhalla-app.xyz`. That path needs Workers Paid and an onboarded sending domain. Before the domain is onboarded, the `EMAIL` binding can send only to verified destination addresses.

Until then, verify `valhalla-app.xyz` in Resend and set `RESEND_API_KEY`. The Worker tries the `EMAIL` binding first, then Resend.

## What the site still needs

Paste the Google client id into `GOOGLE_CLIENT_ID` in `site-config.js`. Paste the Worker URL into `AUTH_URL`. Authorized JavaScript origin: `https://valhalla-app.xyz`.

Run `node --test services/auth/auth-logic.test.mjs` from the repo root.
