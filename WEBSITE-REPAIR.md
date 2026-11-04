# Website repair: November 3, 2026

Added /preview/ and an immediate preview overlay on /app/ through errors.js. Existing error handling and gate.js remain intact. Sign in reveals the original verification flow; Return to preview remains available. The preview does not create authentication flags, connect wallets, run a model, or enable trading.

A push to docs/site triggers the existing Publish Valhalla site workflow. Deployment success and browser behavior must still be verified. This change does not repair the Turnstile backend, configure provider credentials, merge pending PRs, or refresh release/X imagery.

Rollback: revert this commit.
