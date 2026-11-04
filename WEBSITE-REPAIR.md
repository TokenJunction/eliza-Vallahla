# Website entry change: November 3, 2026

## Owner request
Remove the blocking Cloudflare human-check step temporarily. Keep Google/email login and the existing Valhalla logo. Prioritize connectivity over a public preview.

## Deployment behavior
The Pages workflow stages the website in site-build, replaces only mountTurnstile() with an advance to the existing terms/account flow, and removes the previously added preview overlay loader from the deployed errors.js. The original gate.js remains in source for restoration. Wallet behavior is maintained in connect-core.js and site-wallet.js and is included directly in the staged site; the build does not rewrite it. app/index.html, Google/email authentication handlers, email-code verification, and existing logos are not replaced. No account-authentication flags are created by this build change.

Terms/risk acknowledgment remains; users are not marked as having accepted it automatically. Removal of Turnstile temporarily reduces the entry-layer bot protection. Backend authentication remains responsible for validating Google tokens, email codes, sessions, and access permissions.

## Checks
The workflow refuses deployment if expected function boundaries or existing logos are missing. It runs node --check on the staged gate.js, errors.js, connect-core.js, and site-wallet.js, then runs the wallet adapter regression checks. These checks do not prove that Google/email backend services work. Deployment completion and actual sign-in must be verified separately.

## Rollback
Revert this workflow change to restore the original deployed gate behavior. The earlier preview files remain in source, but the updated deployment does not load the preview over /app/.

## Live price and system tickers
The homepage and desk contain separate price and system-status strips. `site-config.js` deliberately leaves `TICKER_URL` and `STATUS_URL` empty until their services are deployed; the interface reports each feed as unavailable rather than showing sample or fabricated live values.

The public price Worker can be deployed separately from the repository root with `npx wrangler deploy --config workers/ticker.toml`. After deployment, verify its HTTPS URL returns SOL data and has the expected CORS response, then set `TICKER_URL` in `site-config.js` to that URL. It returns SOL pricing and up to ten Solana tokens from DexScreener's top-boost feed.

The status strip requires a public health endpoint configured as `STATUS_URL`. The existing `valhalla-repair` Worker writes status on an hourly schedule, so it is not a real-time feed; the UI marks reports older than 15 minutes unavailable. Configure and deploy a suitably frequent, verified health monitor before setting `STATUS_URL`.

After both endpoints are configured, merge the site changes to `docs/site` (or manually start the Pages workflow). GitHub Actions builds and verifies the site, then publishes it to Pages. The price Worker deploy and Pages deploy are separate operations; publishing the website alone does not deploy either Worker.
