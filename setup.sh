#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/valhalla-elizaos"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 23.3+ and npm are required. Install them, then rerun setup.sh." >&2
  exit 1
fi

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 23 || (major === 23 && minor >= 3) ? 0 : 1)"; then
  echo "Node.js 23.3 or newer is required." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required for valhalla-elizaos. Install Bun, then rerun setup.sh." >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/package-lock.json" || ! -f "$BACKEND_DIR/bun.lock" ]]; then
  echo "A committed npm or Bun lockfile is missing; refusing to generate one during setup." >&2
  exit 1
fi

echo "Installing root dependencies from package-lock.json..."
npm --prefix "$ROOT_DIR" ci --legacy-peer-deps

for cache_dir in "$ROOT_DIR/node_modules/.cache" "$BACKEND_DIR/node_modules/.cache"; do
  if [[ -d "$cache_dir" ]]; then
    rm -rf -- "$cache_dir"
  fi
done

echo "Installing ElizaOS dependencies from bun.lock..."
(
  cd "$BACKEND_DIR"
  bun install --frozen-lockfile
  bun run type-check
)

echo "Valhalla core dependencies verified."
