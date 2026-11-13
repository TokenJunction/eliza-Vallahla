#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
python3 website/scripts/build-site.py && python3 website/scripts/test-site.py && python3 scripts/test_private_pack_export.py && node website/scripts/test-wallet.cjs && node --test website/scripts/gate.test.cjs website/scripts/os.test.cjs website/scripts/desk.test.cjs website/scripts/host-route.test.cjs website/scripts/journey.test.cjs website/scripts/desktop.test.cjs website/scripts/minify.test.cjs scripts/hive-updater.test.mjs scripts/hive-node.test.mjs scripts/wren-relay.test.mjs scripts/zeus-publish.test.mjs && node website/scripts/minify-site.mjs
