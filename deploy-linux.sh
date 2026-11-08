#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "   VALHALLA OS V38: LINUX HEADLESS DAEMON DEPLOY          "
echo "=========================================================="

# 1. Update and install basic runtime dependencies
sudo apt-get update && sudo apt-get install -y curl unzip git build-essential

# 2. Install the pinned Bun runtime if needed
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "1.4.2" ]; then
  echo "[INSTALL] Installing Bun..."
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 3. Pull latest repository
git pull origin develop || true

# 4. Install dependencies
bun install

# 5. Build standalone binary or start daemon
echo "[BUILD] Compiling Linux sovereign engine..."
bun build ./src/index.ts --compile --minify --target=bun-linux-x64 --outfile ./dist/valhalla-engine-linux || true

echo "=========================================================="
echo "   LINUX SETUP COMPLETE! READY FOR SYSTEMD DAEMON         "
echo "=========================================================="
