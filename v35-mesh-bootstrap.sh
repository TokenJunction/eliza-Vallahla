#!/bin/sh
# Non-root universal bootstrapper for the Valhalla V35 static mesh.
set -eu

BASE="${VALHALLA_DISTRO_BASE:-https://valhalla-app.xyz/distro}"
DEST="${VALHALLA_HOME:-$HOME/.valhalla}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() { curl -fsSL "$1" -o "$2"; }

fetch "$BASE/latest.tar.gz" "$TMP/latest.tar.gz"
fetch "$BASE/latest.tar.gz.sha256" "$TMP/latest.sha256"
EXPECTED=$(cut -d' ' -f1 "$TMP/latest.sha256" | tr -d '[:space:]')

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/latest.tar.gz" | cut -d' ' -f1)
else
  ACTUAL=$(shasum -a 256 "$TMP/latest.tar.gz" | cut -d' ' -f1)
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "[!] SHA-256 mismatch: expected $EXPECTED, got $ACTUAL" >&2
  exit 1
fi

mkdir -p "$DEST"
tar -xzf "$TMP/latest.tar.gz" -C "$DEST"
cd "$DEST/valhalla"
npm install --omit=dev --legacy-peer-deps
echo "[+] Valhalla mesh worker installed in $DEST/valhalla (verified $ACTUAL)"

if [ -n "${VALHALLA_DISPATCH_TOKEN:-}" ] && [ "${#VALHALLA_DISPATCH_TOKEN}" -ge 32 ]; then
  exec node start_native_engine.js
fi
echo "[*] Set VALHALLA_DISPATCH_TOKEN (>= 32 chars) and run: node start_native_engine.js"
