# ValOS onboarding package

This reusable introduction describes the current ValhallaOS code boundary and the proposed, unverified ValOS token. It is not an offer to sell a token. Do not add a purchase URL, price, countdown, supply, utility, holder right, or return claim until independently verified and separately approved.

## Quick start

1. Visit `/os/` to explore the public, paper-first desk; no account is needed for the public page.
2. Wallet connection can display a public address. It does not load balances or positions.
3. Use only the local paper simulation. It accepts assumed inputs and does not request a signature or execute an order.
4. Read `/whitepaper/` and `/disclosure/` for product and risk boundaries.
5. ValOS status is at `/valos/`; currently there is no verified token identity or purchase path.

## Verified capabilities and limits

Repository code and fixtures establish static routes, a local paper-trade journal, a read-only wallet address display, disabled live trading/payout flags, and a browser account gate that checks a configured server session. They do not prove a live deployment or external auth/chat/status availability.

No ValOS contract/mint, network, tokenomics, price, market, or purchase endpoint is identified. There is no verified Brain or SIWS backend. Do not claim token access, governance, rewards, investment returns, audit, listing, launch date, or legal approval.

## Configuration and secret names

Public-only token fields are in `website/site-config.js`, under `VALHALLA_SITE.VALOS`:

| Field | Initial value | Use |
|---|---|---|
| `STATUS` | `planned-unverified` | Non-authoritative status text; identity is not verified. |
| `NETWORK` | empty | No chain/network is supplied. |
| `MINT_ADDRESS` | empty | No canonical mint/contract is supplied. |
| `EXPLORER_URL` | empty | No explorer link is provided. |
| `PURCHASE_URL` | empty | No purchase endpoint is available. |
| `PURCHASE_APPROVED` | `false` | No separate purchase approval; page controls stay disabled regardless. |
| `X_PROFILE_URL` | empty | Do not guess the official profile. |
| `X_PROFILE_OWNER_CONFIRMED` | `false` | Set only after the owner confirms the exact profile. |
| `X_HANDLE` | empty | Optional public label after profile confirmation. |
| `X_SHARE_TEXT` | cautious draft | Opens only a user-initiated compose/share action. |

Never put private keys, wallet seeds, auth secrets, model-provider credentials, email keys, or database credentials in public configuration. `docs/worker-secret-names.example` is an external Worker secret-name reference only; it contains names, not values. No token-specific server secret or API is defined here.

The X profile/follow link remains hidden until its exact URL is configured and `X_PROFILE_OWNER_CONFIRMED` is true. Ask the owner to supply/confirm the URL; do not infer it from a ticker, branch, or prior profile. Sharing opens X’s compose intent only after a user click. Nothing is auto-posted, pinned, or authenticated, and the site never asks for X credentials. The displayed pinned-post text is a draft that requires owner review.

## Release and rollback

1. Coordinate Pages publishers and Vercel ownership; keep the publisher readiness gate closed until one publisher is selected.
2. Verify canonical identity read-only and use testnet-only validation first. No on-chain transaction is part of this package.
3. Build the website from `website/` into `site-build/`; test `/`, `/app/`, `/os/`, `/valos/`, assets, and the release marker.
4. For a separately approved staging release, correlate one run to the source SHA and unique request ID; verify the deployed marker before promotion.
5. Roll back through the selected publisher to the last reviewed source SHA and verify its release marker. Do not alter DNS as an ad-hoc rollback.

No production deployment, DNS change, billable service, token creation, or transaction is authorized by this package.

## Support and risk disclosure

Support contact: **[owner to confirm and publish a monitored channel]**. Never send passwords, seed phrases, private keys, payment details, or sensitive account data to a placeholder or unverified channel.

Digital assets can lose all value and may be illiquid. Contract, issuer, custody, wallet, phishing, regulatory, tax, and operational risks may apply. No safety, utility, profit, or return is guaranteed. This is not financial, investment, or legal advice; no audit or legal clearance is claimed.

## Milestone calendar

The downloadable [`/valos/milestones.ics`](https://valhalla-app.xyz/valos/milestones.ics) contains undated VTODO items with stable UIDs. Its `DTSTAMP` is file metadata only; it deliberately has no DTSTART, DUE, or scheduled event time. The owner must approve actual dates, times, and a target calendar before creating Google Calendar events. Calendar synchronization is not implemented. The user-provided November 9–15, 2026 inspection found no matching ValOS/Valhalla/token-launch calendar milestones.
