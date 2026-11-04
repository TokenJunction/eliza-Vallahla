# Wallet connection repair: November 4, 2026

No open GitHub Issues were returned at inspection time. No tickets are closed by this change.

The site build now repairs Wallet Standard registration, feature method binding, Solana signing-account selection, and the signMessage request shape. Corrected Backpack matching prevents selection of Phantom for Backpack. Injected providers with both connect and signMessage are preferred when available. Solflare mobile browse routing is retained.

Wallet buttons gain consistent dark/gold styling, labeled icons, in-progress state, duplicate-click prevention, and visible status/errors on the wallet screen. Controls re-enable after completion or rejection. Existing Valhalla logo files and app HTML are preserved.

Changes are applied to the staged deployment artifact by scripts/build-site.py. Source wallet files remain available unchanged for rollback. The existing temporary Turnstile-step removal and preview-overlay removal are preserved. Google/email authentication and signature verification are not disabled. No transaction signing is added.

The workflow runs JavaScript syntax and mocked adapter regression checks before Pages publication. These tests have not yet run at commit preparation time. Real extension/mobile wallet approval and deployment success require separate verification.

Rollback: revert this commit.
