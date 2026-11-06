# Local edge hooks

This change does not edit `valhallaMasterEngineV35.js`.

Wren wires these calls after review.

1. Start `createOllamaTunnelClient` on the owner PC.
2. Pass a device grant that the relay server issued.
3. The production URL is `wss://eliza-valhalla.onrender.com`. An `https` URL for that host converts to `wss`.
4. The Socket.IO path is `/relay`. The first message is the auth frame.
5. The client posts only to `http://127.0.0.1:11434/api/generate`.
6. The model must match the grant list exactly. `qwen2.5-coder:14b` is used only when that list contains it.
7. When the device is offline, the client calls the policy callback and stays unavailable.
8. Cloud work is a server choice. The callback must return `runCloud: true` and `authorized: true`.
9. This client does not wake the PC.
10. Tests use `127.0.0.1` and `NODE_ENV=test`. That path does not skip authentication.
11. The ngrok connector is not installed. The status API never listens on port 11434.

## Not verified

Live TLS, a Gene cloud RPC certificate, self-custody, a live Ollama process, and an ngrok tunnel are not verified. An absent Ollama process returns unavailable. This client does not promise a free-plan wake time.

Socket.IO `4.8.4` is the pinned release in the `^4.8.1` range.
