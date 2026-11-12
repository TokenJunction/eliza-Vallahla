# Administrator notes

The public site and the Render blueprint stay at the repository root on `docs/site`. This folder is the customer API. It is not a second website and it is not applied as a Render service by the root `render.yaml`. Do not point GitHub Pages at this folder.



You create the host accounts. This repo does not contain your keys.

## Customer API service

The customer API entrypoint is `backend/valhallaMasterEngineV35.js`; `npm start` from `backend/` runs it. The root `render.yaml` does not start this service, and the customer API is not live. A separately approved Render service would need the repository's `backend/` directory as its root, Node.js 20 or newer, `npm install` as its build command, and `npm start` as its start command. Provide the platform-assigned `PORT` and the environment below through the host's secret/configuration settings. Do not change the existing Render service as part of this setup.

Set `CUSTOMER_ADMIN_EMAIL` for a customer install, or set `VALHALLA_FACTORY=1` with `MASTER_ADMIN_EMAIL` for the factory. Generate a one-time bootstrap code locally with:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')"
```

Store the 64-character value only as the host secret `VALHALLA_BOOTSTRAP_CODE`. It is not returned by `/health` or written to application logs. The API consumes it after the first successful bootstrap; remove it from the host configuration immediately after setup so a process restart cannot re-arm bootstrap.

`SESSION_SECRET` is required. `VALHALLA_LICENSE_PUBLIC_KEY` is a PEM-encoded Ed25519 public key; missing or invalid configuration fails closed for Pro activation. Supabase, Redis, signing, encryption, and provider credentials are optional integrations and must remain unavailable until configured and explicitly enabled.

## Keep these private

`SESSION_SECRET`, `VALHALLA_BOOTSTRAP_CODE`, `SETUP_MASTER_KEY`, `VALHALLA_SIGNING_PRIVATE_KEY`, `VALHALLA_LICENSE_PUBLIC_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_URL`, provider API keys, and webhook secrets.

Generate the signing key on the server with `node scripts/generate-signing-key.js`. The files stay in `backend/data` and are gitignored. Copy them into the host secret store. Do not commit them.

## Upgrade and rollback

1. Export the workspace from `GET /api/setup/export`. That file has no secrets.
2. Deploy the new build.
3. Apply `supabase/migrations/001_v35.sql` if you use Supabase.
4. To roll back, deploy the previous build and import the exported file. Restore secret values from your own backup. The export cannot restore them.

## Ollama

Use an HTTPS address you control. Localhost and plain HTTP are rejected. When that address does not answer, cloud calls run only if that provider key is stored. Otherwise the request is unavailable.

## Live trading

Live trading is not enabled. There is no transaction signer in this service.
