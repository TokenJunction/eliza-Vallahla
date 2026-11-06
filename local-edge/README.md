# Local edge offline modules

These files are not merged into the running engine. They do not start a public listener, call a provider, or check a customer PC.

The three modules are:

- `lib/IdentityManager.js` issues single-use device grants. The default cloud cap is 0. Jupiter is not a privilege. A missing store, or an unknown production mode, fails closed. This file does not perform two-factor authentication and does not store a device private key.
- `backend/wsRelayServer.js` accepts a device that dials out. `createRelayServer` does not listen. Production refuses `ws://`. The test listener binds only `127.0.0.1`. External HTTP stays at 5 seconds or less. A local model stream uses a separate deadline, 30 seconds by default.
- `local-edge/ollamaTunnelClient.js` posts generate calls only to `http://127.0.0.1:11434/api/generate`. Chat stays on `/api/chat`. Tests pass a fake `fetch`.

`ws` is installed only for this package. Run:

```bash
npm install
npm test
```

A passing test uses mock responses and loopback sockets. It does not prove TLS, a certificate, Ollama, or a live device.
