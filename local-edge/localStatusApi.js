import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const NGROK_CONNECTOR = Object.freeze({
  installed: false,
  exposesOllama: false,
  uptimePromise: false,
  reason: "ngrok client is not installed",
});

function presentedToken(req) {
  const header = req.headers.authorization || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function tokenOk(presented, expected) {
  const left = createHash("sha256").update(String(presented)).digest();
  const right = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

export function createLocalStatusApi(options = {}) {
  const token = typeof options.token === "string" ? options.token : "";
  if (token.length < 16) return { available: false, reason: "local-api-token-required", ollamaExposed: false };
  const getState = typeof options.getState === "function" ? options.getState : () => ({ available: false, reason: "device-asleep" });
  return {
    available: true,
    ollamaExposed: false,
    uptimePromise: false,
    ngrok: NGROK_CONNECTOR,
    listen(port = 0) {
      if (Number(port) === 11434) return Promise.resolve({ ok: false, reason: "ollama-port-refused" });
      const server = createServer((req, res) => {
        if (!tokenOk(presentedToken(req), token)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ available: false, reason: "auth-required" }));
          return;
        }
        const state = getState() || { available: false, reason: "device-asleep" };
        const body = { available: state.available === true, reason: state.reason || "device-asleep" };
        if (req.url === "/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.end(`event: status\ndata: ${JSON.stringify(body)}\n\n`);
          return;
        }
        if (req.url === "/status") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(body));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ available: false, reason: "not-found", ollamaExposed: false }));
      });
      return new Promise((resolve) => {
        server.on("error", () => resolve({ ok: false, reason: "listen-failed" }));
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          resolve({
            ok: true,
            port: address.port,
            close: () => new Promise((done) => server.close(done)),
          });
        });
      });
    },
  };
}
