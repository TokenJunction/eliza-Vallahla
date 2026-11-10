#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 - << 'PY'
import pathlib
import re
import sys

patterns = [
    ("sk_", re.compile(r"sk_")),
    ("sb_secret_", re.compile(r"sb_secret_")),
    ("hf_", re.compile(r"hf_")),
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
]
root = pathlib.Path("website")
files = [path for path in (root / "os").rglob("*") if path.is_file()]
files.extend(path for path in root.rglob("*.html") if path.is_file())
seen = set()
found = []
for path in files:
    if path in seen:
        continue
    seen.add(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    for name, pattern in patterns:
        if pattern.search(text):
            found.append(f"{path}: {name}")
if found:
    print("public secret pattern found:")
    print("\n".join(found))
    sys.exit(1)
print(f"public secret scan passed ({len(seen)} files)")
PY
