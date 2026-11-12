#!/usr/bin/env python3
"""Prefix an SPDX header to every tracked first-party source file."""
import subprocess
from pathlib import Path

EXTENSIONS = {".js", ".mjs", ".cjs", ".css", ".py", ".sh"}
SKIP_PARTS = {"vendor", "node_modules", "site-build"}
MARKER = "SPDX-License-Identifier"


def header(path):
    if path.suffix in {".js", ".mjs", ".cjs"}:
        return ("// Copyright (c) 2026 TokenJunction LLC\n"
                "// SPDX-License-Identifier: MIT\n")
    if path.suffix == ".css":
        return ("/* Copyright (c) 2026 TokenJunction LLC */\n"
                "/* SPDX-License-Identifier: MIT */\n")
    return ("# Copyright (c) 2026 TokenJunction LLC\n"
            "# SPDX-License-Identifier: MIT\n")


names = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                       check=True).stdout.split()
failed = []
changed = 0
skipped = 0
for name in names:
    path = Path(name)
    if path.suffix not in EXTENSIONS or path.name.endswith(".min.js"):
        continue
    if SKIP_PARTS & set(path.parts):
        skipped += 1
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        failed.append(name)
        continue
    if MARKER in text:
        skipped += 1
        continue
    head = header(path)
    if text.startswith("#!"):
        first, rest = text.split("\n", 1)
        updated = first + "\n" + head + rest
    else:
        updated = head + text
    path.write_text(updated, encoding="utf-8")
    changed += 1

print(f"headers added: {changed}")
print(f"skipped: {skipped}")
for name in failed:
    print(f"not utf-8, left alone: {name}")
