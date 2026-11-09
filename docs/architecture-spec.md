# ValhallaOS V38: AI-Cloud OS foundation

Status: proposed isolated foundation, not a deployed V38 release.

## Product and topology
The OS shell, conversational interface and scoped memory are primary. Trading is optional. Zeus coordinates policy and context; worker nodes execute bounded authorized jobs. Keep the interactive response path independent of background queue availability. Models, queues and workers are replaceable adapters behind stable user-facing services.

## Staircase policy
Check scoped, fresh memory first. Route triage and extraction to eligible local providers before cloud providers. Grounded SEARCH must not silently degrade into ungrounded reasoning. Keep local-only data local. A cloud adapter is treated as metered unless explicitly configured otherwise; allowMetered must come from trusted server policy. Adapter labels do not establish account access, model availability or actual cost.

The isolated foundation is src/services/v38/foundation.mjs. It preserves routePrompt and routeAndExecute result shapes, but existing callers still require migration to server-authenticated or server-issued guest context. It does not replace src/services/modelRouter.ts and does not authenticate requests itself. Authorize, result-validation, node-enrollment, dispatch and provenance policies are mandatory injected gates; production must not use the permissive fixtures from tests.

Cache keys include subject/tenant scope, task type, privacy, grounding and memory/conversation revisions. Cache outages do not block otherwise authorized inference. No durable memory implementation is included. Source URLs and grounded=true are metadata, not proof of truth; real validation must corroborate authorized evidence. No zero-latency or sub-second guarantee is made.

## Worker protocol and recovery
Enroll owner-authorized nodes using trusted Ed25519 public keys and explicit capabilities. Bind every attempt to node ID, task ID, scope, input hash and expiry. Use resultSigningBytes exactly for the current JavaScript wire format. Signatures prove attribution, not truth. Cross-language canonicalization needs its own compatibility review.

Each registered transport has a persistent listener. This prototype allows one in-flight task per node and concurrent work on separate nodes. Timeout cleanup and replay protection are attempt-scoped. Three consecutive task/protocol failures quarantine a node and invoke a notification callback, never a shell command. Recovery belongs to a separately authorized, bounded supervisor; no sudo or automatic arbitrary self-rewriting.

Registries and pending attempts are in memory. They are NOT durable BullMQ leases, distributed scheduling or persistent idempotency. Add those before relying on Zeus restarts or multiple coordinators. No worker result is written to memory automatically. Future adapters must implement authenticated transports, owner consent, resource limits and explicit source access; localhost is the executing machine, not an arbitrary remote node.

## Migration and release gates
1. Restore and verify public conversation separately; this foundation does not fix or publish the website.
2. Add real backend provider, provenance, memory and authorization adapters; never put provider secrets in client configuration.
3. Add durable task state, leases, budgets, retry classification and staged repair policies.
4. Add TypeScript declarations/bridges and migrate actual callers without removing their contracts.
5. Build/typecheck/test in the repository's Node 24.15.0 and Bun 1.4.2 workspace; run bounded staged live tests before a specific deployment approval.

Develop contains service source; docs/site is the separate current public-site branch. The supplied OverseerDesk.tsx and HeroSection.tsx paths were not found on develop and are not fabricated here. git origin develop is invalid; review-branch pushes use git push origin <review-branch>. This work does not deploy an admin console, activate trading, register remote nodes, upgrade hosting plans or promise passive income.

## Website source and static build

`website/` is the authoritative website source for this branch. `python3 website/scripts/build-site.py` stages its explicit static allowlist into `site-build/`, excluding test files, hidden files, backend source and server configuration. The build preserves the `/`, `/app/`, `/os/`, and existing desktop assets; it also keeps the existing preview-overlay removal needed by the sign-in page. The build does not deploy Workers or create an API function.

`vercel.json` uses the same `site-build/` output, runs local static route, wallet, auth-session, settings, and release-marker fixture checks, and redirects `/app` to `/app/`. This configuration is a static build definition, not proof of Vercel project or Git deployment settings. Vercel preview origins are not on the auth/chat Worker allowlists described below. Do not treat a successful Vercel build as live-service or production-host verification.

The manual `deploy-valhalla.yml` builds and tests `website/` before it uploads a Pages artifact. It does not download the prior Google Drive package. `scripts/release_artifact.py` remains an optional, explicitly reviewed archive validator: its URL and expected SHA-256 are required inputs, and its archive traversal, path, size, and per-file digest checks remain covered by fixture tests. No production manifest or unverified Drive digest is part of the site release path. The earlier workflow failure, run `42606443037`, was caused by the Drive URL returning a non-gzip response.

The Pages build writes `release.json` from the exact 40-character source SHA, unique request ID, and a deterministic digest of the staged website. The deploy job still calls `scripts/verify_valhalla_release.py`, which retries with bounded HTTPS requests and accepts only parsed marker JSON whose `sha` and `request_id` both match. `deploy-valhalla.sh --repo OWNER/REPO --ref BRANCH [--environment NAME]` retains its existing interface, fetches the branch SHA, generates a unique request ID, correlates exactly one run by run name/event/branch/SHA, watches with `gh run watch --exit-status`, and fails closed on discovery or workflow errors.

### Pages and domain ownership gate

The manual Pages workflow requires the repository variable `VALHALLA_PAGES_PUBLISHER_READY=true`. It is intentionally not set by this PR. Do not set it until the repository owner has reviewed and consolidated every Pages publisher and selected one source of truth.

The separate `docs/site` branch remains an active publisher outside this PR branch. Its current Pages workflow pushes on `docs/site`, shares the `valhalla-pages` concurrency group with cancellation enabled, and calls the GitHub Pages API to set the CNAME and HTTPS enforcement. It can therefore cancel or overwrite a `develop` release and can change live Pages settings. This PR cannot edit that branch or the repository's Pages configuration; until maintainers coordinate a single publisher, the readiness gate must remain unset. Do not dispatch a production deployment as part of this work.

`website/` and `site-build/` configure static build inputs only; they do not prove which branch Vercel publishes or change its project settings. The domain `valhalla-app.xyz` and its `www` origin are referenced by the existing service configuration, but DNS control, registration ownership, certificates, and Pages/Vercel settings are external and have not been independently verified here. No DNS, custom-domain, hosting, or provider setting was changed.

## Authentication and browser/backend boundary

The browser uses the existing Google/email-code provider configured by the public `AUTH_URL`; this change does not switch providers. The auth Worker contract available on the separate `docs/site` branch provides `/auth/human`, `/auth/nonce`, `/auth/google`, `/auth/email/start`, `/auth/email/verify`, `/auth/access`, and `/auth/logout`. The browser now treats the session token returned by Google/email verification as provisional until `/auth/access` confirms `ok` and a future server expiry. It sends the bearer token with credentials and no-store caching, and requires that server check again when `/app/` loads. A missing, invalid, expired, or unverifiable server session cannot open the account desk. Cached `localStorage` account/session fields are display preferences only; the public paper desk remains a local simulation, not an authenticated account.

The inspected Worker source validates Google credentials and email codes server-side, consumes nonces, optionally verifies Turnstile proof, checks bearer tokens against live session records, and revokes sessions at logout. Its CORS origins and Turnstile hostnames are restricted to `https://valhalla-app.xyz` and `https://www.valhalla-app.xyz`; the session/device cookie is `Secure`, `SameSite=None`, and partitioned for cross-origin credentialed requests. A Vercel preview is consequently not an authorized sign-in origin. The Worker source and credentials are not deployed by this static build, and no live authentication request was made; confirm that the external Worker still matches this contract before release. Google authorized origins, Turnstile action/host, email delivery, KV, Worker secrets, cookie behavior, and session revocation require provider-side verification.

`website/site-config.js` is the centralized **public** runtime configuration. It may contain public service URLs, OAuth client ID, and Turnstile site key; it must never contain signing, model, email, database, or provider secrets. `docs/worker-secret-names.example` lists names only for external Worker secret-manager configuration. The deployed auth/chat Worker routes, available credentials, and production CORS behavior were not verified in this task.

## GUI service contracts and disabled capabilities

The existing chat UI posts `{text, history, stream}` to the configured chat Worker at `/chat`; the inspected `docs/site` Worker accepts that shape, checks the origin and server-side rate-limit binding, and returns a reply or an explicit error. Chat provider credentials remain server-side. The endpoint is external to this branch and no live request was made. CORS on the current Worker source permits only the two custom-domain origins.

No Brain API implementation is present in this branch or the current `docs/site` Worker set. `BRAIN_URL` is empty, the `/api/` page is documentation only, and the wallet sign-in page fails closed without requesting a signature or claiming a wallet-auth session. Re-enable Brain or SIWS integration only after its implementation, authorization contract, service origin, and tests are reviewed.

`STATUS_URL`, `TICKER_URL`, `AGENT_API_URL`, and `HIVE_URL` remain empty; absent feeds report unavailable. `HIVE_ENABLED`, `REWARDS_PAYOUT_ENABLED`, and `LIVE_TRADING` remain false. The GUI may run local paper simulations but does not execute trades, transfer payouts, enroll remote nodes, or treat a locally saved agent URL as an authorized live service. Do not enable privileged features without a verified server implementation and authorization.

## Local verification and external prerequisites

The repository's static-site checks are:

```sh
python3 website/scripts/build-site.py
python3 website/scripts/test-site.py
python3 tests/test_valhalla_site_release.py
node website/scripts/test-wallet.cjs
node --test website/scripts/gate.test.cjs website/scripts/os.test.cjs website/scripts/desk.test.cjs website/scripts/connect-page.test.cjs website/scripts/settings.test.cjs
```

The release fixture suite remains `python3 scripts/test_release_artifact.py`, `python3 tests/test_deploy_valhalla.py`, and `python3 tests/test_valhalla_marker.py`; `shellcheck deploy-valhalla.sh` checks the launcher. Fixture/mocked successes do not establish live auth, email delivery, chat/Brain/status availability, CORS on a provider, Vercel/Pages settings, DNS, a production marker, or a deployment.

Before any separately approved release, the owner must coordinate or disable the competing `docs/site` publisher, confirm the Vercel project is preview-only or otherwise intentionally owned, configure the Pages environment and readiness variable, verify domain ownership/DNS/HTTPS, and validate external Worker credentials, origin settings, email, Turnstile, and KV. This PR does not modify live hosting, dispatch production workflows, or claim those prerequisites have passed.
