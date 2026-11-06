# Identity hooks

This change does not edit `valhallaMasterEngineV35.js`.

Wren wires these calls after review.

1. Load `ROOT_ADMIN_EMAIL` from the operator environment on the server. The default is none.
2. Verify the OIDC token on the server.
3. Call `assessRootAdmin({ claims, env })` with those verified claims.
4. A smart account address is not a root admin. A wallet address is not a root admin.
5. In the browser, call `createIdentityManager(config)` and await it.
6. The call uses `Web3AuthMPCCoreKit` from `@web3auth/mpc-core-kit@3.6.0` and awaits `init()`.
7. Solana uses `@toruslabs/tss-frost-lib` (`ed25519`). Ethereum uses `@toruslabs/tss-dkls-lib` (`secp256k1`). Pass the curve. There is no default curve.
8. Call `manager.login(idToken)`. That calls `loginWithJWT({ verifier, verifierId, idToken, subVerifier })`.
9. `verifierId` is the stable OIDC `sub`. The `iss` and `sub` pair is the owner key.
10. When `manualSync` is true, the module calls `commitChanges()` after login.
11. When the status is `REQUIRED_SHARE`, call `inputFactorKey`.
12. `enableMfa` and `createFactor` call the SDK. This module does not store or return the factor.
13. When `available` is false, show the reason. Do not start an SSS wallet.
14. Call `mapErc4337Owner` only when viem and the owner mapping are configured. It never grants root.

## Not verified

Live Web3Auth enterprise nodes are not called here. Self-custody recovery is not verified. A missing package or a missing enterprise config returns `available: false`.
