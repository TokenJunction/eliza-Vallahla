# Valhalla V35 deployment readiness

## Current deployment boundaries

The public website is a static GitHub Pages site built from `site-build` by `.github/workflows/pages.yml` on `docs/site`. Render hosts the separate ElizaOS backend; the frontend must not be switched to Vercel or have its production DNS changed as part of this deployment.

The ElizaOS runtime is for health reporting and simulated/paper workflows only. It must not store wallet private keys, sign transactions, submit trades, or autonomously post to social accounts. Trading, social dispatch, private-key storage, and Zeus idle jobs are explicitly off by default.

## Local setup

1. Use Node.js 23.3 or newer and Bun, as required by the current ElizaOS CLI.
2. Run `bash setup.sh` on macOS/Linux or `.\setup.ps1` on Windows. The scripts use `npm ci --legacy-peer-deps` with the root lockfile, then `bun install --frozen-lockfile` and the ElizaOS TypeScript check. Install Node.js and Bun before running them; they do not make system-wide runtime changes.
3. Copy `.env.production.example` into the deployment provider's secret manager. Never commit populated environment files.
4. Run `npm run build` and `npm test` from the repository root.
5. Apply `supabase/migrations/20261105000000_valhalla_v35_foundation.sql` only after linking the intended Supabase project and reviewing the migration.

The ElizaOS `start` command validates its environment before launch. Production requires at least one configured model-provider key; Supabase and Upstash REST URL/token pairs must be complete when used, and unsupported trading, key-storage, social-dispatch, and Zeus idle-job switches must remain disabled. Redis and Supabase are optional integrations and are not represented as connected merely because a URL is configured.

The database policies on the existing personal tables use Supabase's authenticated `auth.uid()` claim, not an email address supplied by a client. Vault audit records are service-role-only. The service-role key must never be exposed to a browser.

The Valhalla device sign-in does not create a Supabase Auth session. `auth.uid()` stays empty for that sign-in. A row policy that compares `auth.uid()` does not prove the device sign-in. The backend must not treat the device token as a Supabase user id.

## Customer mapping

The isolated backend maps a checked device sign-in to a customer UUID. Use `mapCustomerFromBearer` in `lib/customer-identity.js`. That function calls `GET /auth/access` with the bearer token and then reads or inserts `public.customer_identity` with the service-role key.

Rules for that map:

- Send the bearer token to the auth worker. Do not accept `email`, `user_id`, or a customer id from request headers.
- Store only the SHA-256 email hash. The table has no email column and no admin column.
- The customer row is a personal record. `role` stays `customer`. It does not grant leader access and it does not receive `LEADER_EMAIL`, `DEVICE_COOKIE_SECRET`, or the service-role key.
- `leader` is true only when the auth worker reports Google, the email code, and the configured leader mailbox for that live session. Do not copy that flag onto the customer row.
- Apply `supabase/migrations/20261106000000_customer_identity_mapping.sql` only on the intended project. The migration grants select and insert to `service_role` and revokes the browser roles. It does not link `customer_id` to `auth.users`.

## Sign-in session deploy order

This change does not rotate `DEVICE_COOKIE_SECRET` and it does not change the live secret value. Deploy the website and the `valhalla-auth` worker together. Deploy the website first if you must split the work. Do not deploy the worker first: the new worker requires a one-time nonce, and the previous website does not send one.

After the worker is deployed, old bearer tokens stop working because they have no live `sess:` record. Users sign in again. That is expected.

A recognized, unrevoked device can skip the extra email code when "Always ask" is off. A device that is new, revoked, or expired still needs the code. The account owner still needs Google plus the email code. A display name does not grant owner access. Sign-in responses return a masked mailbox hint. They do not return the full name or the profile photo.

The member id is `customer_id` in tenant `valhalla`. The mapper ignores a user id, email, name, or photo supplied by the browser. It does not set Supabase `auth.uid()`.

This pull request does not change the Cerberus public caller. Authenticated rate limits for those workspace endpoints remain a separate priority.

Turnstile stays off for this worker until you set `TURNSTILE_SECRET` on `valhalla-auth`. Use the same secret as `valhalla-turnstile-verify`. Do not commit it. Set it only after the website that calls `/auth/human` is live:

`npx wrangler secret put TURNSTILE_SECRET --config workers/auth.toml`

When the secret is set, `/auth/human` checks the token with Cloudflare. The widget action must be `valhalla-signin` and the hostname must be `valhalla-app.xyz` or `www.valhalla-app.xyz`. A missing token, a reused token, the wrong action, the wrong host, or a siteverify error is rejected. When the secret is unset, those routes do not ask for the pass.

No new key is created by this change. `AUTH_KV` is the existing namespace. New keys use the prefixes `sess:`, `nonce:`, `human:`, and `gcred:`. Each of those keys has a TTL. They do not store the mailbox address or the signing secret.

If `DEVICE_COOKIE_SECRET` is exposed, replace it and delete the live session keys. This change does not do that replacement. Generate a new random value outside the repository, then run:

`npx wrangler secret put DEVICE_COOKIE_SECRET --config workers/auth.toml`

Then delete keys that start with `sess:`, `nonce:`, `human:`, and `gcred:` in KV namespace `9f0316ce34f84f53bf3ffa5ef31cbe72`. Users sign in again. A person who knows only the signing secret cannot mint a working plan token after this deploy, because the token also needs a live `sess:` row. A person who can both sign and write KV can still create a row until you rotate the secret and delete those keys.

KV does not provide a compare-and-swap. Two identical sign-in requests that arrive at the same moment can both pass the one-time check once. The mailbox code is still removed after a successful check, and a later request with the same nonce fails.

## Hosting setup

- **GitHub Pages:** `.github/workflows/pages.yml` publishes the static website from `docs/site`. It does not deploy Workers or the ElizaOS runtime.
- **Render:** `render.yaml` describes a separate Docker service with auto-deploy disabled and the ElizaOS `/health` check. Its free plan may sleep when idle and is not suitable for an always-on production service. The runtime exposes read-only Zeus and Gorgo agent definitions; these are not authenticated admin access or per-user sandboxes.
- **Queue:** the site blueprint disables the BullMQ queue. The web process uses `VALHALLA_QUEUE_ROLE=producer` in the blueprint; outside it, the legacy default is `combined` (producer and consumers). A separately configured worker uses `consumer`. Do not run combined and standalone consumers together unless intentionally scaling consumers. The web dispatch endpoint requires explicit `VALHALLA_QUEUE_ENABLED=true`, a private TLS `REDIS_URL` and a server-only `VALHALLA_DISPATCH_TOKEN` of at least 32 bytes. It does not accept an email header as identity. Treasury, signing, trading, arbitrary execution, and social jobs are rejected or blocked. This does not authenticate a browser user as the owner; owner authentication remains in the verified Google-plus-code Worker flow.
- **Model providers:** the ElizaOS runtime loads the OpenAI and Google GenAI plugins only when their corresponding API keys are set. No social plugins, wallet integrations, or transaction executors are installed.
- **Supabase:** provision and link the intended project before applying the migration.
- **Upstash and model providers:** credentials in `.env.production.example` are blank. Add only the provider credentials the configured agent actually uses.

Configure `MASTER_ADMIN_EMAIL` and `LEADER_EMAIL` as matching server-side secrets; do not hardcode the owner address in public source. Owner operations still require a server-verified Google identity and sign-in code. An email-only login or client-supplied header does not grant owner access.

Run `npm run validate:env` to check production secrets and the server-side owner email allowlist before release. It never authenticates an HTTP request; the existing Google verification and second-factor flow remains the admin authorization boundary. The validator and deployment scripts are excluded from GitHub Pages output.

## Existing Render background worker: review only

The reported `node valhallaWorker.js` failure was a missing root file at revision `737938505026614a8eb86dddb1d5f1116d6301b9`, not evidence of an Ollama, Clerk, or model failure. The root npm package is `valhalla-site`, not the ElizaOS Bun project. Its declared Node range is `>=22`; the root lockfile currently includes a dependency requiring Node >=24. Node 22.23.4 installed the lockfile with an engine warning and passed the root tests locally. Node 26.13.0 was tested locally with the locked dependencies and an isolated Redis fixture; that is not verification of the deployed environment. Do not treat a version downgrade as the missing-file fix or infer compatibility from installation alone.

For owner review of the **already existing** worker, not a new blueprint service:

1. Verify the actual service, workspace, candidate revision and private Redis network independently. Do not assume service ID, plan, or secret values. Keep auto-deploy disabled until separately approved.
2. Set repository branch to the reviewed candidate branch/revision, root directory to the repository root, runtime to Node, build command to `npm ci --legacy-peer-deps && npm run preflight:worker`, and start command to `npm run start:worker` (the existing `node valhallaWorker.js` also works). Use an installed Node version supported by the lockfile and tested for the candidate.
3. Configure `NODE_ENV=production`, `VALHALLA_QUEUE_ENABLED=true`, `VALHALLA_QUEUE_ROLE=consumer`, `VALHALLA_EXECUTION_MODE=paper`, and a private TLS `REDIS_URL` (`rediss://`) through the existing secret mechanism. Keep `VALHALLA_TRADING_ENABLED`, `VALHALLA_SOCIAL_ENABLED`, `VALHALLA_KEY_STORAGE_ENABLED`, and `ZEUS_IDLE_ENABLED` unset or `false`. The worker does not need the web dispatch token. The web producer needs its own existing server-only token and the same queue backend; review its settings separately, and do not leave it in `combined` mode when using the standalone worker.
4. From the repository root and using the target runtime, run `npm ci --legacy-peer-deps`, `npm test`, `npm run build`, then `npm run preflight:worker` with the intended configuration supplied securely. The build performs a structural check before generating the site; the worker preflight additionally checks activation, role, paper mode and Redis URL without connecting. It does not establish backend availability, private networking, service identity or authorization. Never print configuration values.
5. After separate deployment approval, review structured worker readiness logs. A Redis disconnect reports not ready; startup is bounded to 10 seconds, and reconnect attempts are backed off. No HTTP web server or fake heartbeat is used. Redis is required and a failed connection is not ready.

Producer Redis commands have a 5-second per-command deadline, including enqueue commands; offline commands are rejected rather than buffered, and unfulfilled commands are not automatically resent. An enqueue can involve more than one Redis command. On an enqueue command timeout the producer is marked not ready and its connection is reset before reconnecting. A timeout after transmission means acceptance is unknown: the job may still have been queued, so do not treat the timeout as proof of failure or automatically retry the enqueue. Consumers use a separate connection with persistent reconnects.

Rollback: after separately approved operational action, disable queue dispatch and restore the previously reviewed web configuration; stop the standalone consumer only after accounting for active jobs. Reverting the entrypoint alone reintroduces the known missing-file failure. Do not provision another worker or claim the existing worker is healthy without observing it.

Queue outputs are synthetic paper/status results, not proof of machine, model, network, vault or trading health. `vault-check` is blocked, not a vault access check. Tenant-owned or paid jobs remain unsupported until a real authorization and ownership protocol exists. This change does not implement autonomous or model capabilities.

For local integration coverage, point `VALHALLA_TEST_REDIS_SERVER` to an absolute path of a Redis server binary and run `node --test valhallaRedis.integration.test.cjs` from the root. The test starts its own loopback-only Redis instances in temporary directories, generates a temporary TLS certificate with OpenSSL, and shuts down its own processes. It never uses an existing `REDIS_URL`. Without the binary setting the Redis and TLS tests are skipped. The TLS fixture checks trust and hostname verification, not the actual production private network or provider certificate. Review the real target, network, configuration and candidate revision separately before any approved rollout.

## Not included in this deployment

No Supabase, Render, Vercel, or Upstash resources are provisioned by this repository. No production API keys, OAuth redirect changes, signing keys, transaction executor, X/Twitter dispatcher, or automated social-posting credentials are configured. Financial chart views must use real, labeled source data; placeholder or simulated values must not be presented as live P&L.

The Render service is not production-ready until its required secrets and model credentials are supplied, a deployment is explicitly initiated, and its health endpoint is verified. No periodic pinger is used to defeat host idle behavior; continuous operation requires an appropriate always-on Render plan and separately provisioned Redis. The runtime reports capabilities as disabled; it does not implement trading, key storage, social dispatch, per-user sandbox provisioning, or Zeus idle jobs.
