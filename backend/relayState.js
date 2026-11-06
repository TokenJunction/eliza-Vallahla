import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
  maxHttpBufferSize: 128 * 1024,
  maxChunkBytes: 16 * 1024,
  maxPromptBytes: 16 * 1024,
  maxResponseBytes: 256 * 1024,
  maxConnectionBytes: 4 * 1024 * 1024,
  maxActive: 2,
  maxQueue: 5,
  authTimeoutMs: 5000,
  grantTtlSeconds: 300,
  taskTimeoutMs: 120000,
  maxTaskTimeoutMs: 300000,
});

export const TASK_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const NAME_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function byteLength(value) {
  if (typeof value !== "string") return -1;
  return Buffer.byteLength(value, "utf8");
}

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function replyHash(parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

export function createSingleWriter() {
  let tail = Promise.resolve();
  return function singleWriter(work) {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function createNonceStore({ max = 5000, ttlMs = LIMITS.grantTtlSeconds * 1000 } = {}) {
  const items = new Map();
  const write = createSingleWriter();
  function sweep(now) {
    for (const [jti, exp] of items) {
      if (exp <= now) items.delete(jti);
    }
  }
  return {
    use(jti, exp, now) {
      return write(() => {
        sweep(now);
        if (items.has(jti)) return { ok: false, reason: "nonce-used" };
        if (items.size >= max) return { ok: false, reason: "nonce-store-full" };
        items.set(jti, exp);
        return { ok: true };
      });
    },
    get size() {
      return items.size;
    },
  };
}

export function createIdempotencyStore(max = 5000) {
  const rows = new Map();
  return {
    claim(key) {
      const row = rows.get(key);
      if (!row) {
        if (rows.size >= max) return { ok: false, reason: "idempotency-full" };
        rows.set(key, { state: "pending", replyHash: null });
        return { ok: true, state: "pending" };
      }
      if (row.state === "done") return { ok: true, state: "done", replyHash: row.replyHash };
      return { ok: false, state: "pending", reason: "duplicate-in-flight" };
    },
    complete(key, digest) {
      const row = rows.get(key);
      if (!row || row.state !== "pending") return false;
      row.state = "done";
      row.replyHash = digest;
      return true;
    },
    release(key) {
      const row = rows.get(key);
      if (!row || row.state !== "pending") return false;
      rows.delete(key);
      return true;
    },
  };
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const QUERY_CREDENTIALS = new Set([
  "token",
  "grant",
  "access_token",
  "authorization",
  "bearer",
  "jwt",
  "vh_session",
]);

export function credentialQuery(url) {
  const text = String(url || "");
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : "";
  if (!query) return false;
  for (const part of query.split("&")) {
    const name = decodeURIComponent(part.split("=")[0] || "").toLowerCase();
    if (QUERY_CREDENTIALS.has(name)) return true;
  }
  return false;
}

export function headerValue(headers, name) {
  if (!headers) return "";
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] || "") : "";
}

export function validateRelayTransport(req, options = {}) {
  const env = options.env || {};
  const address = req && req.socket ? req.socket.remoteAddress : "";
  const testTransport = env.NODE_ENV === "test" && options.allowTestLoopback === true && isLoopbackAddress(address);
  if (credentialQuery(req && req.url)) {
    return { ok: false, reason: "query-credentials-rejected", authBypass: false };
  }
  if (testTransport) return { ok: true, testTransport: true, authBypass: false };
  const forwarded = headerValue(req && req.headers, "x-forwarded-proto");
  if (options.renderProxy === true && forwarded === "https") {
    return { ok: true, testTransport: false, authBypass: false };
  }
  return { ok: false, reason: "wss-required", authBypass: false };
}
