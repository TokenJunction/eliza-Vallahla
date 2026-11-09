#!/usr/bin/env python3
"""Write a source-correlated marker for a completed static website build."""

import argparse
import hashlib
import json
import re
from pathlib import Path

SOURCE_SHA = re.compile(r"[0-9a-f]{40}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


def site_digest(directory):
    root = Path(directory)
    if not root.is_dir():
        raise ValueError("site build directory does not exist")
    digest = hashlib.sha256()
    files = sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())
    for path in files:
        if path.is_symlink():
            raise ValueError("site build contains a symbolic link")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("site build contains a non-regular file")
        relative = path.relative_to(root).as_posix()
        if relative == "release.json":
            raise ValueError("site build already contains release.json")
        name = relative.encode("utf-8")
        content = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def write_release(directory, sha, request_id):
    if not isinstance(sha, str) or not SOURCE_SHA.fullmatch(sha):
        raise ValueError("source SHA must be 40 lowercase hexadecimal characters")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("invalid deployment request ID")
    root = Path(directory)
    metadata = {
        "sha": sha,
        "request_id": request_id,
        "package_sha256": site_digest(root),
    }
    marker = root / "release.json"
    try:
        with marker.open("x", encoding="utf-8") as output:
            json.dump(metadata, output, ensure_ascii=True, sort_keys=True, indent=2)
            output.write("\n")
    except Exception:
        marker.unlink(missing_ok=True)
        raise
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="built static website directory")
    parser.add_argument("--sha", required=True, help="exact source commit SHA")
    parser.add_argument("--request-id", required=True, help="deployment request ID")
    args = parser.parse_args()
    try:
        write_release(args.directory, args.sha, args.request_id)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"release marker generation failed: {exc}\n")


if __name__ == "__main__":
    main()
