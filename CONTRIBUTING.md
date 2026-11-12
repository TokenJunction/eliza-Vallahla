<!-- Copyright (c) 2026 TokenJunction LLC -->
<!-- SPDX-License-Identifier: MIT -->

# Contributing

Changes are proposed as GitHub pull requests against `develop`. Discussion happens on the pull request or in GitHub issues.

## Licence and notices

This repository is distributed under the MIT License in [LICENSE](LICENSE). Portions derive from [elizaOS/eliza](https://github.com/elizaOS/eliza), which is also MIT-licensed; the upstream copyright and permission notice is preserved in [NOTICE](NOTICE).

Do not remove or reword the upstream elizaOS notice, the TokenJunction copyright line, or the MIT permission text. Contributions are accepted under the same MIT terms (inbound = outbound). Run the notice check before opening a pull request:

```bash
node scripts/check-notices.mjs
```

## Developer Certificate of Origin

Every commit in a pull request must carry a `Signed-off-by` line naming the commit author. The `dco` workflow checks every non-merge commit between the pull request base and head and fails when one is missing or names a different address.

Sign off the commit you just made:

```bash
git commit --amend -s
```

Sign off every commit already on your branch, then update the pull request:

```bash
git rebase --signoff develop
git push --force-with-lease
```

The trailer takes the form:

```text
Signed-off-by: Your Name <you@example.com>
```

By adding the line you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or have the right to submit it under the project's licence, and that you understand the contribution and its record are public. There is no separate CLA to sign.

Bots such as Dependabot are exempt, and merge commits are not checked.

## Readable source

The public source is the audit trail; do not hide it. Keep JavaScript, HTML, Python and shell source readable. Do not commit minified, packed or obfuscated source into `website/`, `src/`, `scripts/`, `api/` or `tests/`. Minification belongs only in generated build output such as `site-build/`.

## Checks before requesting review

- `node scripts/check-notices.mjs`
- the `dco` workflow
- the existing website and deployment workflows for changed paths

Do not commit secrets, credentials, `.env` files or sourcemaps. Keep the existing SPDX headers on source files.
