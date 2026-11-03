#!/usr/bin/env python3
"""Post the next Valhalla note, or preview it when DRY_RUN is true.

X API v2, OAuth 1.0a. Secrets stay in the environment. They are not written here.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "social" / "queue.yml"
TWEET_URL = "https://api.x.com/2/tweets"


def load_posts(path: Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    posts: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("  - id:"):
            if current:
                posts.append(current)
            current = {"id": line.split(":", 1)[1].strip(), "text": ""}
        elif current is not None and line.startswith("    text:"):
            value = line.split(":", 1)[1].strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            current["text"] = value.replace('\\"', '"')
    if current:
        posts.append(current)
    if len(posts) != 14:
        raise SystemExit(f"Expected 14 posts, found {len(posts)}")
    for post in posts:
        if len(post["text"]) > 280:
            raise SystemExit(f"{post['id']} is {len(post['text'])} characters")
        if "profit" in post["text"].lower() and "not promise" not in post["text"].lower() and "does not promise" not in post["text"].lower():
            if "promise profit" not in post["text"].lower() and "no profit" not in post["text"].lower():
                pass
        if "Vallahla" in post["text"] or "Valahlla" in post["text"]:
            raise SystemExit(f"Bad spelling in {post['id']}")
    return posts


def pick(posts: list[dict[str, str]], today: dt.date | None = None) -> dict[str, str]:
    day = (today or dt.datetime.now(dt.timezone.utc).date()).timetuple().tm_yday
    return posts[(day - 1) % len(posts)]


def oauth_header(method: str, url: str, consumer_key: str, consumer_secret: str, token: str, token_secret: str) -> str:
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(dt.datetime.now(dt.timezone.utc).timestamp())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }

    def enc(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    base = "&".join(f"{enc(key)}={enc(oauth[key])}" for key in sorted(oauth))
    base_string = "&".join([method.upper(), enc(url), enc(base)])
    signing = f"{enc(consumer_secret)}&{enc(token_secret)}"
    digest = hmac.new(signing.encode(), base_string.encode(), hashlib.sha1).digest()
    oauth["oauth_signature"] = base64.b64encode(digest).decode()
    return "OAuth " + ", ".join(f'{enc(key)}="{enc(oauth[key])}"' for key in sorted(oauth))


def post_tweet(text: str) -> str:
    names = ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET")
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise SystemExit("Missing secrets: " + ", ".join(missing))
    header = oauth_header(
        "POST",
        TWEET_URL,
        os.environ["X_API_KEY"],
        os.environ["X_API_SECRET"],
        os.environ["X_ACCESS_TOKEN"],
        os.environ["X_ACCESS_SECRET"],
    )
    body = json.dumps({"text": text}).encode()
    request = urllib.request.Request(TWEET_URL, data=body, method="POST")
    request.add_header("Authorization", header)
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read().decode()


def write_summary(dry: bool, post: dict[str, str], extra: str = "") -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    lines = [
        "### Valhalla social",
        "",
        f"DRY_RUN={str(dry).lower()}",
        "",
        f"id: {post['id']}",
        "",
        post["text"],
        "",
        extra,
    ]
    text = "\n".join(lines)
    print(text)
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")


def main() -> None:
    posts = load_posts(QUEUE)
    chosen = pick(posts)
    dry = os.environ.get("DRY_RUN", "true").strip().lower() in {"1", "true", "yes"}
    if dry:
        write_summary(True, chosen, "No request was sent to X.")
        return
    result = post_tweet(chosen["text"])
    write_summary(False, chosen, result[:500])


if __name__ == "__main__":
    main()
