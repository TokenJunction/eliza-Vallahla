#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || [ "$(node --version)" != "v24.15.0" ]; then
  echo "Node 24.15.0 is required." >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "1.4.2" ]; then
  echo "Bun 1.4.2 is required." >&2
  exit 1
fi
test -f scripts/alwaysOnBeacon.ts

echo "Local prerequisites checked. No service was started or deployed."
echo "The beacon observes host metrics only. The autonomous overseer is not ready."
