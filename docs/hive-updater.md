# Hive updater

The updater has three separate processes. None of them is started by the website or by a launcher.

1. **Zeus** finishes a coding action and signs a release with `scripts/zeus-publish.mjs`.
2. **Wren** receives the signed release with `scripts/wren-relay.mjs` and pushes it to every connected node on that channel with server-sent events.
3. **The node** uses `scripts/hive-node.mjs` to verify the release, install its files, run the health check, and launch the new version. A failed health check or launch restores the previous files and leaves the node version unchanged.

Akershus (`customer`) and Zeus (`overseer`) are separate signed channels. A customer node cannot accept a Zeus artifact, and gated categories (`login`, `trading`, `dns`, `secrets`, `production-merge`) are never auto-applied.

## Start Wren

```sh
HIVE_RELAY_PUBLIC_KEY_FILE=/secure/release-public.pem \
HIVE_RELAY_TOKEN='a-long-random-token' \
HIVE_RELAY_HOST=127.0.0.1 HIVE_RELAY_PORT=8787 \
node scripts/wren-relay.mjs
```

`GET /latest?channel=akershus` returns the current release, `GET /events?channel=akershus` is the SSE stream, `POST /publish` accepts a signed release, `POST /report` records node status, and `GET /updates/health.json` reports live relay health. The publisher token is required for publish and report when set. The release signature is always checked.

## Publish from Zeus

```sh
node scripts/zeus-publish.mjs \
  --relay http://127.0.0.1:8787 \
  --key /secure/release-private.pem \
  --token "$HIVE_RELAY_TOKEN" \
  --channel akershus \
  --path akershus/system \
  --version 1.0.1 \
  --category system \
  --file app.js=dist/app.js
```

The command exits non-zero if the relay rejects the release. `--dry-run` prints the signed release without sending it. A manifest can supply `channel`, `path`, `version`, `category`, `issuedAt`, and text `files`.

## Run a node

```sh
HIVE_RELAY_URL=http://127.0.0.1:8787 \
HIVE_RELAY_TOKEN="$HIVE_RELAY_TOKEN" \
HIVE_RELEASE_PUBLIC_KEY_FILE=/secure/release-public.pem \
HIVE_NODE_ID=node-a \
HIVE_NODE_CHANNEL=akershus \
HIVE_NODE_ROLE=customer \
HIVE_NODE_ROOT=/srv/valhalla \
HIVE_NODE_STATE=/srv/valhalla/.hive/node.json \
HIVE_HEALTHCHECK='node healthcheck.js' \
HIVE_LAUNCH='node app.js' \
node scripts/hive-node.mjs
```

The health command must exit `0`; otherwise the installed files are rolled back. The launch command is started after health passes and is detached from the updater. The node writes its last accepted version and known-good entries to `HIVE_NODE_STATE`, and reports the result to Wren. Release file names are constrained to the install root; absolute paths, parent traversal, drive-qualified paths, and `.hive` files are refused.

## Tests

```sh
node --test scripts/hive-updater.test.mjs scripts/hive-node.test.mjs \
  scripts/wren-relay.test.mjs scripts/zeus-publish.test.mjs
```
