#!/bin/sh
# Builds an immutable static mesh bundle for CDN / R2 hosting.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${1:-$ROOT/dist/distro}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT" "$STAGE/valhalla"
cd "$ROOT"

# Node orchestrator, Python telemetry, and Wasm binaries (each optional if absent).
for f in start_native_engine.js unified_idle_orchestrator.js valhallaQueueEngine.js \
         shifting_staircase_router.js agentCrossTalkBus.js package.json; do
  [ -f "$f" ] && cp "$f" "$STAGE/valhalla/"
done
[ -d lib ] && cp -R lib "$STAGE/valhalla/lib"
[ -d distro ] && cp -R distro "$STAGE/valhalla/distro"
[ -f scripts/performance_report.py ] && mkdir -p "$STAGE/valhalla/telemetry" && cp scripts/performance_report.py "$STAGE/valhalla/telemetry/"
find . -path ./node_modules -prune -o -name '*.wasm' -print 2>/dev/null | while read -r w; do
  mkdir -p "$STAGE/valhalla/wasm" && cp "$w" "$STAGE/valhalla/wasm/"
done

# Fixed mtime/owner and sorted entries keep the archive reproducible.
tar --sort=name --mtime='2020-01-01 00:00:00' --owner=0 --group=0 --numeric-owner \
  -czf "$OUT/latest.tar.gz" -C "$STAGE" valhalla 2>/dev/null \
  || tar -czf "$OUT/latest.tar.gz" -C "$STAGE" valhalla

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum latest.tar.gz | cut -d' ' -f1 > latest.tar.gz.sha256)
else
  (cd "$OUT" && shasum -a 256 latest.tar.gz | cut -d' ' -f1 > latest.tar.gz.sha256)
fi
echo "Built $OUT/latest.tar.gz ($(cat "$OUT/latest.tar.gz.sha256"))"
