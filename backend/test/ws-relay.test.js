import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { SignJWT } from "jose";
import { io } from "socket.io-client";
import { costReceiptOk, DEFAULT_ISSUER, issueDeviceGrant, RELAY_AUD, verifyDeviceGrant } from "../relayGrant.js";
import { createIdempotencyStore, createNonceStore, createSingleWriter, validateRelayTransport } from "../relayState.js";
import { attachRelay, resolveTaskTimeout } from "../wsRelayServer.js";

process.env.NODE_ENV = "test";

const MODEL = "qwen2.5-coder:14b";

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event)), 4000);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerDeps(role = "owner") {
  return {
    lookupAccount: async ({ tenantId, deviceId }) => ({ ok: true, role, tenantId, deviceId }),
    verifyOwner: async () => ({ ok: true }),
    registerDevice: async ({ tenantId, deviceId }) => ({ ok: true, tenantId, deviceId, role: "owner" }),
  };
}

function receipt(frame) {
  return { allocator: "wren", allocated: true, taskId: frame.taskId, tenantId: frame.tenantId, amountUsd: 0 };
}

async function withRelay(extra, fn) {
  const httpServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("app");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const relay = attachRelay(httpServer, {
    env: { NODE_ENV: "test" },
    allowTestLoopback: true,
    renderProxy: false,
    authTimeoutMs: 400,
    issuer: DEFAULT_ISSUER,
    registerTask: async (input) => ({ ok: true, taskId: input.taskId, tenantId: input.tenantId }),
    ...extra,
  });
  try {
    await fn({ relay, port: httpServer.address().port, httpServer });
  } finally {
    await relay.close();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  }
}

async function device(port, grant, onTask) {
  const socket = io(`http://127.0.0.1:${port}`, {
    path: "/relay",
    reconnection: false,
    transports: ["websocket", "polling"],
    forceNew: true,
  });
  const controllers = new Map();
  socket.on("task", async (frame) => {
    const controller = new AbortController();
    controllers.set(frame.taskId, controller);
    let seq = 0;
    try {
      const result = await onTask(frame, controller.signal, (data) => {
        seq += 1;
        socket.emit("chunk", { taskId: frame.taskId, seq, data });
      }, socket);
      if (!socket.connected) return;
      if (controller.signal.aborted) socket.emit("aborted", { taskId: frame.taskId });
      else if (!result || result.ok === false) socket.emit("error", { taskId: frame.taskId, reason: (result && result.reason) || "device-error" });
      else socket.emit("done", { taskId: frame.taskId });
    } catch {
      if (socket.connected) socket.emit("aborted", { taskId: frame.taskId });
    }
  });
  socket.on("abort", (message) => {
    if (message && controllers.has(message.taskId)) controllers.get(message.taskId).abort();
  });
  await once(socket, "connect");
  socket.emit("auth", { grant });
  const auth = await once(socket, "auth-ok");
  return { socket, auth };
}

test("transport trust is https on the Render proxy or an explicit loopback test", () => {
  const remote = { socket: { remoteAddress: "203.0.113.8" }, headers: { "x-forwarded-proto": "https" }, url: "/relay/" };
  assert.equal(validateRelayTransport(remote, { renderProxy: true, env: { NODE_ENV: "production" } }).ok, true);
  assert.equal(validateRelayTransport(remote, { renderProxy: false, env: { NODE_ENV: "production" } }).ok, false);
  assert.equal(validateRelayTransport({
    socket: { remoteAddress: "203.0.113.8" },
    headers: { "x-forwarded-proto": "http" },
    url: "/relay/",
  }, { renderProxy: true }).reason, "wss-required");
  const loop = validateRelayTransport({
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
    url: "/relay/?EIO=4",
  }, { allowTestLoopback: true, env: { NODE_ENV: "test" } });
  assert.equal(loop.ok, true);
  assert.equal(loop.authBypass, false);
  assert.equal(validateRelayTransport({
    socket: { remoteAddress: "127.0.0.2" },
    headers: {},
    url: "/relay/",
  }, { allowTestLoopback: true, env: { NODE_ENV: "test" } }).ok, false);
  assert.equal(validateRelayTransport({
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
    url: "/relay/?token=abc",
  }, { allowTestLoopback: true, env: { NODE_ENV: "test" } }).reason, "query-credentials-rejected");
  const timeout = resolveTaskTimeout(120000, { NODE_ENV: "production" });
  assert.equal(timeout.ok, true);
  assert.equal(resolveTaskTimeout(50000, { NODE_ENV: "production" }).ok, false);
  assert.equal(resolveTaskTimeout(300001, { NODE_ENV: "test" }).ok, false);
});

test("a grant requires the owner verifier and is single use", async () => {
  const key = await extraKey();
  const denied = await issueDeviceGrant({
    key,
    verifyOwner: async () => ({ ok: true }),
    stateProvider: async () => ({ verified: true, role: "owner" }),
  }, { tenantId: "tenant-a", deviceId: "device-a", verified: true, role: "owner", models: [MODEL] });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "owner-verifier-required");
  const customer = await issueDeviceGrant({ key, ...ownerDeps("customer") }, {
    tenantId: "tenant-a",
    deviceId: "device-a",
    role: "owner",
    register: true,
    verified: true,
    models: [MODEL],
  });
  assert.equal(customer.reason, "owner-register-only");
  const issued = await issueDeviceGrant({ key, ...ownerDeps("owner") }, {
    tenantId: "tenant-a",
    deviceId: "device-a",
    role: "customer",
    models: [MODEL],
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.role, "owner");
  const verified = await verifyDeviceGrant(issued.token, { key });
  assert.equal(verified.ok, true);
  assert.equal(verified.role, "owner");
  const parts = issued.token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.equal((await verifyDeviceGrant(tampered, { key })).reason, "signature-rejected");
  const expired = await issueDeviceGrant({ key, ...ownerDeps("owner") }, {
    tenantId: "tenant-a",
    deviceId: "device-a",
    models: [MODEL],
    now: Date.now() - 301000,
  });
  assert.equal((await verifyDeviceGrant(expired.token, { key })).reason, "expired");
  const store = createNonceStore();
  const now = Date.now();
  const [first, second] = await Promise.all([
    store.use(verified.jti, now + 1000, now),
    store.use(verified.jti, now + 1000, now),
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
  assert.equal([first, second].some((item) => item.reason === "nonce-used"), true);
});

test("tokens without iat, with an extra claim, or with HMAC are rejected", async () => {
  const key = await extraKey();
  const base = {
    purpose: "device-relay",
    tenantId: "tenant-a",
    deviceId: "device-a",
    role: "owner",
    models: [MODEL],
  };
  const now = Math.floor(Date.now() / 1000);
  const noIat = await new SignJWT(base)
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "JWT" })
    .setIssuer(DEFAULT_ISSUER)
    .setAudience(RELAY_AUD)
    .setExpirationTime(now + 300)
    .setJti("jti-no-iat-value")
    .sign(key.privateKey);
  assert.equal((await verifyDeviceGrant(noIat, { key })).reason, "iat-required");
  const extra = await new SignJWT({ ...base, signature: "extra" })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "JWT" })
    .setIssuer(DEFAULT_ISSUER)
    .setAudience(RELAY_AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti("jti-extra-sign")
    .sign(key.privateKey);
  assert.equal((await verifyDeviceGrant(extra, { key })).reason, "claim-rejected");
  const hmac = await new SignJWT(base)
    .setProtectedHeader({ alg: "HS256", kid: key.kid, typ: "JWT" })
    .setIssuer(DEFAULT_ISSUER)
    .setAudience(RELAY_AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti("jti-hmac-value")
    .sign(new TextEncoder().encode("test-secret-test-secret-test-secret"));
  assert.equal((await verifyDeviceGrant(hmac, { key })).reason, "header-rejected");
  assert.equal((await verifyDeviceGrant("not.a.jwt.extra", { key })).reason, "token-rejected");
  assert.equal(costReceiptOk({ allocator: "relay", allocated: true, taskId: "task-0001", tenantId: "tenant-a", amountUsd: 1 }, {
    taskId: "task-0001",
    tenantId: "tenant-a",
  }), false);
});

test("the relay scope leaves other HTTP routes in place", async () => {
  await withRelay({}, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app");
  });
});

test("query credentials, ping, and a late auth frame do not authenticate", async () => {
  const key = await extraKey();
  await withRelay({ key, authTimeoutMs: 200 }, async ({ relay, port }) => {
    const queried = io(`http://127.0.0.1:${port}`, {
      path: "/relay",
      query: { token: "abc" },
      reconnection: false,
      timeout: 2000,
      forceNew: true,
    });
    await once(queried, "connect_error");
    queried.close();
    assert.equal(relay.stats().credentialQuery, true);
    const socket = io(`http://127.0.0.1:${port}`, {
      path: "/relay",
      reconnection: false,
      forceNew: true,
    });
    await once(socket, "connect");
    socket.emit("ping", { authenticated: true });
    await once(socket, "disconnect");
    socket.close();
    assert.equal(relay.stats().preAuth.includes("ping"), true);
    assert.equal(relay.stats().devices, 0);
    const late = io(`http://127.0.0.1:${port}`, { path: "/relay", reconnection: false, forceNew: true });
    await once(late, "connect");
    await once(late, "disconnect");
    late.close();
  });
});

test("a tampered grant and a second device connection are denied", async () => {
  const key = await extraKey();
  await withRelay({ key }, async ({ relay, port }) => {
    const issued = await relay.issue({
      tenantId: "tenant-a",
      deviceId: "device-a",
      models: [MODEL],
    }, ownerDeps());
    const first = await device(port, issued.token, async () => ({ ok: true }));
    const parts = issued.token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    const bad = io(`http://127.0.0.1:${port}`, { path: "/relay", reconnection: false, forceNew: true });
    await once(bad, "connect");
    bad.emit("auth", { grant: tampered, verified: true });
    const denied = await once(bad, "auth-no");
    assert.equal(denied.reason, "signature-rejected");
    bad.close();
    const secondGrant = await relay.issue({
      tenantId: "tenant-a",
      deviceId: "device-a",
      models: [MODEL],
    }, ownerDeps());
    const second = io(`http://127.0.0.1:${port}`, { path: "/relay", reconnection: false, forceNew: true });
    await once(second, "connect");
    second.emit("auth", { grant: secondGrant.token });
    const occupied = await once(second, "auth-no");
    assert.equal(occupied.reason, "device-already-connected");
    second.close();
    first.socket.close();
  });
});

test("duplicate tasks return one hash and abort releases the idempotency row", async () => {
  const key = await extraKey();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withRelay({ key }, async ({ relay, port }) => {
    const issued = await relay.issue({ tenantId: "tenant-a", deviceId: "device-a", models: [MODEL] }, ownerDeps());
    const client = await device(port, issued.token, async (frame, signal, onChunk) => {
      calls += 1;
      if (frame.taskId === "task-0001") {
        await gate;
        if (signal.aborted) return { ok: false, reason: "aborted" };
      }
      if (frame.taskId === "task-0002" && calls < 3) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" }));
        });
      }
      onChunk("same-body");
      return { ok: true };
    });
    const frame = {
      taskId: "task-0001",
      tenantId: "tenant-a",
      deviceId: "device-a",
      prompt: "alpha",
      model: MODEL,
      stream: false,
      costReceipt: receipt({ taskId: "task-0001", tenantId: "tenant-a" }),
    };
    const first = relay.dispatchTask(frame, undefined, () => {});
    const second = await relay.dispatchTask(frame, undefined, () => {});
    assert.equal(second.reason, "duplicate-in-flight");
    release();
    const done = await first;
    assert.equal(done.ok, true);
    const replay = await relay.dispatchTask(frame, undefined, () => {});
    assert.equal(replay.duplicate, true);
    assert.equal(replay.replyHash, done.replyHash);
    assert.equal(replay.replyHash, createHash("sha256").update("same-body").digest("hex"));
    assert.equal(calls, 1);
    const order = relay.stats().order;
    assert.equal(order.indexOf("register:task-0001") < order.indexOf("send:task-0001"), true);
    const abortFrame = { ...frame, taskId: "task-0002", costReceipt: receipt({ taskId: "task-0002", tenantId: "tenant-a" }) };
    const controller = new AbortController();
    const pending = relay.dispatchTask(abortFrame, controller.signal, () => {});
    await delay(50);
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.reason, "aborted");
    const retried = await relay.dispatchTask(abortFrame, undefined, () => {});
    assert.equal(retried.ok, true);
    client.socket.close();
  });
});

test("a chunk from another tenant is not delivered", async () => {
  const key = await extraKey();
  let releaseBeta;
  const betaGate = new Promise((resolve) => {
    releaseBeta = resolve;
  });
  await withRelay({ key }, async ({ relay, port }) => {
    const alphaGrant = await relay.issue({ tenantId: "tenant-a", deviceId: "device-a", models: [MODEL] }, ownerDeps());
    const betaGrant = await relay.issue({ tenantId: "tenant-b", deviceId: "device-b", models: [MODEL] }, ownerDeps());
    const alpha = await device(port, alphaGrant.token, async (frame, signal, onChunk) => {
      onChunk("from-alpha");
      return { ok: true };
    });
    const beta = await device(port, betaGrant.token, async (frame, signal, onChunk) => {
      await betaGate;
      onChunk("from-beta");
      return { ok: true };
    });
    const collected = [];
    const betaTask = relay.dispatchTask({
      taskId: "task-beta",
      tenantId: "tenant-b",
      deviceId: "device-b",
      prompt: "beta-prompt",
      model: MODEL,
      stream: false,
      costReceipt: receipt({ taskId: "task-beta", tenantId: "tenant-b" }),
    }, undefined, (chunk) => collected.push(chunk));
    await delay(40);
    alpha.socket.emit("chunk", { taskId: "task-beta", seq: 1, data: "spoofed-beta" });
    await delay(40);
    assert.equal(collected.includes("spoofed-beta"), false);
    releaseBeta();
    const result = await betaTask;
    assert.equal(result.ok, true);
    assert.deepEqual(collected, ["from-beta"]);
    assert.equal(relay.stats().droppedCrossTenant >= 1, true);
    alpha.socket.close();
    beta.socket.close();
  });
});

test("queue limits and disconnect cancel work that has not finished", async () => {
  const key = await extraKey();
  let started = 0;
  await withRelay({ key, maxActive: 1, maxQueue: 1 }, async ({ relay, port }) => {
    const issued = await relay.issue({ tenantId: "tenant-a", deviceId: "device-a", models: [MODEL] }, ownerDeps());
    const client = await device(port, issued.token, () => {
      started += 1;
      return new Promise(() => {});
    });
    const make = (taskId) => ({
      taskId,
      tenantId: "tenant-a",
      deviceId: "device-a",
      prompt: "wait",
      model: MODEL,
      stream: false,
      costReceipt: receipt({ taskId, tenantId: "tenant-a" }),
    });
    const first = relay.dispatchTask(make("task-0001"));
    await delay(50);
    assert.equal(started, 1);
    const second = relay.dispatchTask(make("task-0002"));
    await delay(20);
    const third = await relay.dispatchTask(make("task-0003"));
    assert.equal(third.reason, "queue-full");
    client.socket.disconnect();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.reason, "device-disconnected");
    assert.equal(right.reason, "device-disconnected");
    assert.equal(started, 1);
  });
});

test("oversized prompts, unknown models, and missing cost do not run", async () => {
  const key = await extraKey();
  let ran = 0;
  await withRelay({ key }, async ({ relay, port }) => {
    const issued = await relay.issue({ tenantId: "tenant-a", deviceId: "device-a", models: [MODEL] }, ownerDeps());
    const client = await device(port, issued.token, async (frame, signal, onChunk) => {
      ran += 1;
      onChunk("nope");
      return { ok: true };
    });
    const base = {
      taskId: "task-0009",
      tenantId: "tenant-a",
      deviceId: "device-a",
      prompt: "small",
      model: MODEL,
      stream: false,
    };
    const missingCost = await relay.dispatchTask(base);
    assert.equal(missingCost.reason, "cost-not-allocated");
    const unknownModel = await relay.dispatchTask({
      ...base,
      taskId: "task-0010",
      model: "unknown-model",
      costReceipt: receipt({ taskId: "task-0010", tenantId: "tenant-a" }),
    });
    assert.equal(unknownModel.reason, "model-rejected");
    const huge = await relay.dispatchTask({
      ...base,
      taskId: "task-0011",
      prompt: "e".repeat(17000),
      costReceipt: receipt({ taskId: "task-0011", tenantId: "tenant-a" }),
    });
    assert.equal(huge.reason, "prompt-too-large");
    const wide = await relay.dispatchTask({
      ...base,
      taskId: "task-0012",
      prompt: "\u00e9".repeat(9000),
      costReceipt: receipt({ taskId: "task-0012", tenantId: "tenant-a" }),
    });
    assert.equal(wide.reason, "prompt-too-large");
    const tool = await relay.dispatchTask({
      ...base,
      taskId: "task-0013",
      tool: "exec",
      costReceipt: receipt({ taskId: "task-0013", tenantId: "tenant-a" }),
    });
    assert.equal(tool.reason, "unknown-frame");
    assert.equal(ran, 0);
    client.socket.emit("mystery", { command: "exec" });
    await delay(30);
    client.socket.close();
  });
});

test("idempotency claims are single writer", async () => {
  const store = createIdempotencyStore();
  const write = createSingleWriter();
  const [left, right] = await Promise.all([
    write(() => store.claim("tenant-a:task-0001")),
    write(() => store.claim("tenant-a:task-0001")),
  ]);
  const states = [left.state, right.state].sort();
  assert.deepEqual(states, ["pending", "pending"]);
  assert.equal([left, right].filter((item) => item.ok).length, 1);
  assert.equal([left, right].some((item) => item.reason === "duplicate-in-flight"), true);
});

async function extraKey() {
  const { generateRelayKey } = await import("../relayGrant.js");
  return generateRelayKey(`kid-${randomBytes(4).toString("hex")}`);
}
