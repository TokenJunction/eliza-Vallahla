# ValhallaOS handoff

Canonical git repository: [TokenJunction/eliza-valhalla](https://github.com/TokenJunction/eliza-valhalla). This file is a living coordination note for the shared static site. Read it, then read the code you will edit. A plan is not proof. Do not overwrite a checked fact with a later intention. Do not deploy from this note.

## Checked refs

Checked with `gh pr view` and `git rev-parse` on 2026-11-06. Re-check before editing. Do not treat a green local test as a deployed build.

| Work | Ref at check | Role |
| --- | --- | --- |
| Public homepage PR | [#20](https://github.com/TokenJunction/eliza-valhalla/pull/20) `e201ade2f77913c6f89100b9c5ff1b61c0c4b24e` | Homepage branch. Not this run's edit target. |
| Customer API PR | [#18](https://github.com/TokenJunction/eliza-valhalla/pull/18) `ae2c04f1d695599d9da9e8f9d893fe170cc8b844` | Auth and site API draft. Not production readiness. |
| Backend draft PR | [#23](https://github.com/TokenJunction/eliza-valhalla/pull/23) `0b84aa4f85e853a5f3da55297089c529c41fecc9` | Task and Jupiter build draft. Not a ready flag. |
| This frontend PR | [#24](https://github.com/TokenJunction/eliza-valhalla/pull/24) branch `cursor/docs-site-command-b4a4` | Owned here. Base `docs/site`. |

Owner routing labels, not commit SHAs: core task auth `b320`, this frontend `cbcc`, homepage `fe64`, identity relay `e35c`. One owner edits one branch. Forge, Skald, and Herald read interfaces. Do not push onto their branches while they are active.

## What is public, and what is not

The owner supplied this Vercel preview URL: <https://eliza-valhalla-5apu4yxg9-token-junction-llc.vercel.app>. This run did not deploy it and does not call it production. The hobby project belongs to Token Junction LLC. The full project id and team token are not written here. There is no signup, trade, or billing on that preview. `valhalla-app.xyz` is not confirmed here as the live alias. Render fixtures on older branches are not a new production change.

## Product rules already in this branch

- Brand is ValhallaOS. The public homepage stays the entry and sign-in surface. The desk must not be described as opening on a trading terminal.
- Wallets in the owner desk are Solflare and MetaMask on Solana only. Read-only connect uses `standard:connect`. A link signature (`solana:signMessage`) is optional and is not a trade. A later swap review may use `solana:signTransaction` only. Do not call `signAndSendTransaction`.
- A wallet signature does not grant leader, billing, automation, or a trade.
- Zeus, FLYWHEEL, and ElizaOS advice stay a disabled Automation panel until a real delegated-execution contract exists.
- Quotes fail closed. `TRADING_ENABLED` defaults off. A shown quote must match input mint, output mint, raw amount, slippage, taker, and cluster. A 30-second age limit is ValhallaOS review policy, not a Jupiter time-to-live. If the provider sends no expiry, say freshness was not supplied.
- `GET /build` instructions are not a ready-to-sign transaction. Do not send them to `/execute`.
- Public RPC readiness is not claimed. `rpcReadiness()` stays unmounted. No client secret and no customer card data.
- Task history on the inspected engine is `GET /api/v1/tasks?conversationId=`, and one task is `GET /api/v1/tasks/{32-hex-id}`. POST `/api/v1/tasks` on that draft returned 200 or 503 after generation. A 202 queued admit is a target, not a checked live behavior. Do not send conversation id `0`.
- Stripe test mode and a five-dollar monthly seat are server work. Do not invent a webhook or collect card numbers here.

## Resume

1. `git status`, `git rev-parse HEAD`, and `gh pr view 24 --json headRefOid,baseRefName`.
2. Read only the files you will change.
3. Run the targeted `node --test` files and record the pass count from that run.
4. Edit only this PR's branch. Commit and push `cursor/docs-site-command-b4a4`.
5. Screenshot a localhost fixture only, and label it fixture. Do not call it a live quote, balance, or signature.

Synthetic wallet strings in tests are design data, not customer accounts.
