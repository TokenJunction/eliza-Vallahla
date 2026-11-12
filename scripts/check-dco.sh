#!/usr/bin/env bash
# Copyright (c) 2026 TokenJunction LLC
# SPDX-License-Identifier: MIT
#
# Verify that every non-merge commit in a range carries a Developer Certificate
# of Origin sign-off matching its author. Usage: check-dco.sh <base-sha> <head-sha>

set -euo pipefail

BASE="${1:-}"
HEAD="${2:-}"

if [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "base commit $BASE is not present; fetching it" >&2
  git fetch --no-tags origin "$BASE" >/dev/null 2>&1 || true
fi

commits="$(git rev-list --no-merges "${BASE}..${HEAD}")"
if [ -z "$commits" ]; then
  echo "No non-merge commits between ${BASE} and ${HEAD}."
  exit 0
fi

checked=0
failed=0
missing=""

for sha in $commits; do
  author_name="$(git show -s --format='%an' "$sha")"
  author_email="$(git show -s --format='%ae' "$sha" | tr 'A-Z' 'a-z')"
  committer_email="$(git show -s --format='%ce' "$sha" | tr 'A-Z' 'a-z')"

  case "$author_name$author_email" in
    *"[bot]"*|*bot@users.noreply.github.com*|*dependabot*)
      echo "skip (bot)  ${sha:0:8} ${author_name}"
      continue
      ;;
  esac

  checked=$((checked + 1))
  message="$(git show -s --format='%B' "$sha")"

  found=0
  while IFS= read -r line; do
    lowered="$(printf '%s' "$line" | tr 'A-Z' 'a-z')"
    case "$lowered" in
      signed-off-by:*"<${author_email}>"*) found=1 ;;
      signed-off-by:*"<${committer_email}>"*) found=1 ;;
    esac
  done <<< "$message"

  if [ "$found" -eq 1 ]; then
    echo "ok          ${sha:0:8} ${author_name} <${author_email}>"
  else
    failed=$((failed + 1))
    subject="$(git show -s --format='%s' "$sha")"
    missing="${missing}  ${sha:0:8}  ${author_email}  ${subject}
"
    echo "MISSING     ${sha:0:8} ${author_name} <${author_email}>"
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "DCO check failed: ${failed} of ${checked} commit(s) have no Signed-off-by line"
  echo "matching the author address:"
  printf '%s' "$missing"
  echo
  echo "Fix with one of:"
  echo "  git commit --amend -s              # the commit you just made"
  echo "  git rebase --signoff ${BASE}       # signs with user.email, which is accepted"
  exit 1
fi

if [ "$checked" -eq 0 ]; then
  echo "DCO check passed: no non-bot commits in this range."
else
  echo "DCO check passed: ${checked} commit(s) signed off."
fi
