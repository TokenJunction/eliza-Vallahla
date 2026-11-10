#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node scripts/pr-public-secret-scan.mjs
