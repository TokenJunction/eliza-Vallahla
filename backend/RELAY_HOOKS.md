# Relay hooks

This change does not edit `valhallaMasterEngineV35.js` or `task-invocation.js`.

Wren wires these calls after review.

1. Create the HTTP server in the existing engine.
2. Call `attachRelay(httpServer, { key, renderProxy: true, issuer })`.
3. The Socket.IO path is `/relay`. Other routes stay on that listener.
4. Trust `x-forwarded-proto: https` only when `renderProxy` is true.
5. A loopback socket is allowed only when `NODE_ENV` is `test` and `allowTestLoopback` is true. That flag does not skip grant checks.
6. Call `issueDeviceGrant` only after `lookupAccount` and `verifyOwner`.
7. A client `verified` flag is ignored. A state provider is not authentication.
8. Device registration is allowed only for an owner, and only through the Wren register function.
9. Send the grant to the device on a server channel. Do not put the grant in a query string.
10. Do not send the task session cookie to the device.
11. The device sends an `auth` event within 5 seconds. A ping is not authentication.
12. Register the task id in the Wren task store before `dispatchTask`.
13. Allocate the task cost in Wren. Pass `{ allocator: "wren", allocated: true, taskId, tenantId, amountUsd }`.
14. The relay does not allocate cost.
15. Idempotency memory is not durable. A completed task returns the same reply hash.
16. Abort, timeout, and disconnect release the in-flight slot. A completed hash stays. The grant `jti` stays single use.
17. One device runs at most 2 tasks, with a queue of 5. Disconnect cancels queued work.

## Not verified

Live TLS on Render is not verified. A Gene cloud RPC certificate is not verified. This module does not promise a free-plan wake time.
