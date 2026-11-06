import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_TIMEOUT_MS,
  DEFAULT_MAX_BODY,
  HARD_MAX_BODY,
  LOCAL_STREAM_DEADLINE_MS,
  acceptTextFrame,
  assertTransportUrl,
  createRelayServer,
  deviceSocketOptions,
  listenLoopback,
  resolveTimeouts,
} from "./wsRelayServer.js";

const requireFromEdge = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../local-edge/package.json"));
const { WebSocket } = requireFromEdge("ws");
const TOKEN = "device-auth-token-1";
const deviceId = "dev-local-device-1";
const activeId = "active-device-0001";

function clockAt(start) {
  return { t: start, now() { return this.t; } };
}

function fingerprintOf() {
  return {
    ok: true,
    fingerprint: "fp",
    request: { model: "qwen2.5-coder:14b", prompt: "hi", stream: false, path: "/api/generate" },
  };
}

async function start(extra = {}) {
  const clock = extra.clock || clockAt(1_000);
  const seen = new Set();
  const released = [];
  const server = http.createServer();
  const relay = createRelayServer({
    server,
    production: false,
    allowDevLoopbackWs: true,
    manualClock: true,
    clock,
    idleTimeoutMs: extra.idleTimeoutMs || 60_000,
    maxConnections: extra.maxConnections || 8,
    maxBodyBytes: extra.maxBodyBytes,
    timeouts: extra.timeouts,
    authenticate(token) {
      if (token !== TOKEN) return { ok: false };
      return {
        ok: true,
        subject: "subject-1",
        tenantId: "tenant-1",
        deviceId,
        activeId,
        sessionVersion: 1,
        deviceVersion: 4,
      };
    },
    fingerprintOf,
    consumeGrant(input) {
      if (extra.consumeGrant) return extra.consumeGrant(input);
      if (seen.has(input.grantId)) return { ok: false, reason: "grant_already_running" };
      seen.add(input.grantId);
      return { ok: true, grant: { expiresAt: input.now + 30_000 } };
    },
    releaseReservation(info) { released.push(info); },
  });
  assert.equal(server.listening, false);
  const address = await listenLoopback(relay);
  assert.equal(address.host, "127.0.0.1");
  return {
    relay,
    clock,
    seen,
    released,
    url: `ws://${address.host}:${address.port}/relay`,
  };
}

function connect(url, headers) {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("open_timeout")), 2000);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message_timeout")), 2000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function authed(url, headers) {
  const ws = await connect(url, headers);
  const pending = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  const hello = await pending;
  return { ws, hello };
}

function collect(ws) {
  const frames = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  return frames;
}

async function waitFor(check) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("production refuses cleartext ws and the factory does not listen", () => {
  assert.equal(assertTransportUrl("ws://127.0.0.1:9/relay", { production: true }).reason, "ws_refused_in_production");
  assert.equal(assertTransportUrl("ws://203.0.113.5/relay", { production: false, allowDevLoopbackWs: true }).reason, "ws_only_loopback");
  const secure = deviceSocketOptions("wss://edge.example/relay", {
    production: true,
    headers: { "x-protocol": "1" },
  });
  assert.equal(secure.ok, true);
  assert.equal(secure.rejectUnauthorized, true);
  assert.equal(secure.servername, "edge.example");
  assert.equal(secure.browserWebSocket, false);
  assert.equal(secure.tlsProven, false);
  assert.equal(secure.headers["x-protocol"], "1");
  assert.equal(deviceSocketOptions("wss://edge.example/relay?token=abcdef", { production: true }).reason, "query_token_refused");
  assert.equal(deviceSocketOptions("wss://edge.example/relay", { headers: { Cookie: "session=secret" } }).reason, "cookie_header_refused");
  assert.throws(() => resolveTimeouts({ externalTimeoutMs: 5001 }), /external_timeout_exceeds_5s/);
  const timeouts = resolveTimeouts({});
  assert.equal(timeouts.externalTimeoutMs, 5000);
  assert.equal(timeouts.localStreamDeadlineMs, LOCAL_STREAM_DEADLINE_MS);
  assert.equal(LOCAL_STREAM_DEADLINE_MS > 5000, true);
  assert.equal(resolveTimeouts({ localStreamDeadlineMs: 45_000 }).localStreamDeadlineMs, 45_000);
  assert.throws(() => resolveTimeouts({ localStreamDeadlineMs: 256 * 1024 }), /local_deadline_out_of_bounds/);
  const server = http.createServer();
  const relay = createRelayServer({
    server,
    manualClock: true,
    clock: clockAt(1),
    authenticate() { return { ok: false }; },
    consumeGrant() { return { ok: false, reason: "unused" }; },
    fingerprintOf,
  });
  assert.equal(server.listening, false);
  assert.equal(relay.stats().listenerStartedByFactory, false);
  assert.throws(() => listenLoopback(relay), /production_listener_refused/);
});

test("bytes are counted before JSON parse, including UTF-8 and a second final frame", () => {
  const lim = { maxBodyBytes: 100 };
  const wide = "é".repeat(60);
  const tooWide = acceptTextFrame(`{"delta":"${wide}"}`, lim, 0);
  assert.equal(tooWide.reason, "frame_too_large");
  assert.equal(tooWide.parsed, false);
  assert.equal(wide.length < 100, true);
  const badUtf = acceptTextFrame(Buffer.from([0xff, 0xfe, 0xfd]), lim, 0);
  assert.equal(badUtf.reason, "frame_not_utf8");
  assert.equal(badUtf.parsed, false);
  const overflow = acceptTextFrame("{" + "x".repeat(30), lim, 80);
  assert.equal(overflow.reason, "stream_too_large");
  assert.equal(overflow.parsed, false);
  assert.equal(DEFAULT_MAX_BODY, 256 * 1024);
  assert.equal(HARD_MAX_BODY, 512 * 1024);
  assert.throws(() => createRelayServer({
    server: http.createServer(),
    maxBodyBytes: HARD_MAX_BODY + 1,
    manualClock: true,
    authenticate() { return { ok: false }; },
    consumeGrant() { return { ok: false }; },
    fingerprintOf,
  }), /max_body_out_of_bounds/);
});

test("the first frame must authenticate within 5 seconds and a query token is refused", async () => {
  const clock = clockAt(1_000);
  const relayBox = await start({ clock });
  try {
    const ws = await connect(relayBox.url);
    relayBox.relay.tick(1_000 + AUTH_TIMEOUT_MS - 1);
    assert.equal(ws.readyState, WebSocket.OPEN);
    const closed = new Promise((resolve) => ws.once("close", resolve));
    relayBox.relay.tick(1_000 + AUTH_TIMEOUT_MS);
    await closed;
    const refused = new WebSocket(relayBox.url + "?token=" + TOKEN);
    const failed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("query_timeout")), 2000);
      refused.once("error", () => { clearTimeout(timer); resolve("error"); });
      refused.once("close", () => { clearTimeout(timer); resolve("close"); });
    });
    assert.equal(typeof failed, "string");
  } finally {
    await relayBox.relay.close();
  }
});

test("auth is one opaque first frame, a cookie is not a credential, and JWT is rejected", async () => {
  const relayBox = await start();
  try {
    const { ws, hello } = await authed(relayBox.url, { Cookie: "session=browser-secret" });
    assert.equal(hello.type, "authenticated");
    assert.equal(hello.deviceId, deviceId);
    assert.equal(hello.activeId, activeId);
    assert.equal(JSON.stringify(hello).includes(TOKEN), false);
    assert.equal(Object.hasOwn(hello, "token"), false);
    const handle = createHash("sha256").update(TOKEN).digest("hex").slice(0, 12);
    assert.deepEqual(relayBox.relay.stats().handles, [handle]);
    const again = nextMessage(ws);
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    assert.equal((await again).reason, "auth_already_complete");
    ws.close();
    const jwtWs = await connect(relayBox.url);
    const closed = new Promise((resolve) => jwtWs.once("close", (code) => resolve(code)));
    jwtWs.send(JSON.stringify({ type: "auth", token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signaturevalue" }));
    assert.equal(typeof await closed, "number");
  } finally {
    await relayBox.relay.close();
  }
});

test("a stale grant does not run a model, and cancel stops one request only", async () => {
  const relayBox = await start();
  try {
    const { ws, hello } = await authed(relayBox.url);
    const frames = collect(ws);
    const first = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_first_request_01",
      nonce: "nonce-1",
      capability: "local.generate",
      taskId: "tsk_first_request_01",
      activeId,
      deviceId,
      now: 1_000,
      request: { model: "qwen2.5-coder:14b", prompt: "one" },
    });
    const second = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_second_request_2",
      nonce: "nonce-2",
      capability: "local.generate",
      taskId: "tsk_second_request_2",
      activeId,
      deviceId,
      now: 1_000,
      request: { model: "qwen2.5-coder:14b", prompt: "two" },
    });
    const replay = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_first_request_01",
      nonce: "nonce-1",
      capability: "local.generate",
      taskId: "tsk_first_request_01",
      activeId,
      deviceId,
      now: 1_100,
      request: { model: "qwen2.5-coder:14b", prompt: "one" },
    });
    assert.equal(first.modelInvoked, false);
    assert.equal(first.dispatched, true);
    assert.equal(replay.ok, false);
    assert.equal(replay.modelInvoked, false);
    assert.equal(replay.reason, "grant_already_running");
    const mismatch = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_other_device_0003",
      nonce: "nonce-3",
      capability: "local.generate",
      taskId: "tsk_other_device_0003",
      activeId: "active-other-device",
      deviceId,
      now: 1_100,
      request: {},
    });
    assert.equal(mismatch.reason, "binding_mismatch");
    assert.equal(mismatch.modelInvoked, false);
    const stopped = relayBox.relay.cancel(hello.connectionId, first.requestId);
    assert.equal(stopped.deviceClosed, false);
    assert.equal(stopped.socketOpen, true);
    await waitFor(() => frames.filter((frame) => frame.type === "execute").length === 2);
    assert.equal(frames.filter((frame) => frame.type === "execute").length, 2);
    ws.send(JSON.stringify({
      type: "result", requestId: second.requestId, seq: 0, done: true, content: "two", activeId, deviceId,
    }));
    ws.send(JSON.stringify({
      type: "result", requestId: first.requestId, seq: 0, done: true, content: "should-not-complete", activeId, deviceId,
    }));
    await waitFor(() => relayBox.relay.streamOutcome(hello.connectionId, second.requestId).status === "completed");
    assert.equal(relayBox.relay.streamOutcome(hello.connectionId, second.requestId).content, "two");
    const cancelled = relayBox.relay.streamOutcome(hello.connectionId, first.requestId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.content, null);
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    await relayBox.relay.close();
  }
});

test("malformed frames, unknown frames, and a second final event do not crash", async () => {
  const relayBox = await start();
  try {
    const bad = await connect(relayBox.url);
    const closed = new Promise((resolve) => bad.once("close", () => resolve("closed")));
    bad.send("not-json");
    assert.equal(await closed, "closed");
    const { ws, hello } = await authed(relayBox.url);
    const frames = collect(ws);
    const sent = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_final_request_01",
      nonce: "nonce",
      capability: "local.generate",
      taskId: "tsk_final_request_01",
      activeId,
      deviceId,
      now: 2_000,
      request: { prompt: "hi" },
    });
    assert.equal(sent.dispatched, true);
    ws.send(JSON.stringify({ type: "nope", activeId, deviceId }));
    ws.send(JSON.stringify({
      type: "result", requestId: sent.requestId, seq: 0, done: true, content: "ok", activeId, deviceId,
    }));
    ws.send(JSON.stringify({
      type: "result", requestId: sent.requestId, seq: 1, done: true, content: "second", activeId, deviceId,
    }));
    await waitFor(() => frames.some((frame) => frame.reason === "frame_after_terminal"));
    assert.equal(frames.some((frame) => frame.reason === "unknown_frame_type"), true);
    assert.equal(relayBox.relay.streamOutcome(hello.connectionId, sent.requestId).content, "ok");
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    await relayBox.relay.close();
  }
});

test("session revoke clears open text and an expired grant releases its reservation", async () => {
  const clock = clockAt(5_000);
  const relayBox = await start({
    clock,
    timeouts: { localStreamDeadlineMs: 5_000 },
  });
  try {
    const { ws, hello } = await authed(relayBox.url);
    const open = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_revoke_request_1",
      nonce: "nonce",
      capability: "local.generate",
      taskId: "tsk_revoke_request_1",
      activeId,
      deviceId,
      now: 5_000,
      request: { prompt: "hi" },
    });
    ws.send(JSON.stringify({
      type: "progress", requestId: open.requestId, seq: 0, delta: "SECRET", activeId, deviceId,
    }));
    await waitFor(() => relayBox.relay.streamOutcome(hello.connectionId, open.requestId).text === "SECRET");
    const revoked = relayBox.relay.markSessionRevoked(hello.connectionId);
    assert.equal(revoked.content, null);
    ws.send(JSON.stringify({
      type: "result", requestId: open.requestId, seq: 1, done: true, content: "SECRET", activeId, deviceId,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const outcome = relayBox.relay.streamOutcome(hello.connectionId, open.requestId);
    assert.equal(outcome.status, "revoked");
    assert.equal(outcome.completed, false);
    assert.equal(outcome.content, null);
    assert.equal(JSON.stringify(outcome).includes("SECRET"), false);
    const later = relayBox.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_after_revoke_0002",
      nonce: "nonce-2",
      capability: "local.generate",
      taskId: "tsk_after_revoke_0002",
      activeId,
      deviceId,
      now: 5_100,
      request: { prompt: "hi" },
    });
    assert.equal(later.reason, "session_revoked");
    assert.equal(later.modelInvoked, false);
  } finally {
    await relayBox.relay.close();
  }

  const expiryClock = clockAt(8_000);
  const expiry = await start({ clock: expiryClock, timeouts: { localStreamDeadlineMs: 5_000 } });
  try {
    const { ws, hello } = await authed(expiry.url);
    const sent = expiry.relay.dispatch({
      connectionId: hello.connectionId,
      grantId: "gnt_expire_request_1",
      nonce: "nonce",
      capability: "local.generate",
      taskId: "tsk_expire_request_1",
      activeId,
      deviceId,
      now: 8_000,
      request: { prompt: "hi" },
    });
    assert.equal(expiry.relay.stats().reserved, 1);
    const execute = await nextMessage(ws);
    assert.equal(execute.type, "execute");
    expiry.relay.tick(8_000 + 5_000);
    assert.equal(expiry.relay.streamOutcome(hello.connectionId, sent.requestId).status, "expired");
    assert.equal(expiry.relay.streamOutcome(hello.connectionId, sent.requestId).content, null);
    assert.equal(expiry.relay.stats().reserved, 0);
    assert.equal(expiry.released.length, 1);
    ws.send(JSON.stringify({
      type: "result", requestId: sent.requestId, seq: 0, done: true, content: "late", activeId, deviceId,
    }));
    const error = await nextMessage(ws);
    assert.equal(error.reason, "frame_after_terminal");
    assert.equal(expiry.relay.streamOutcome(hello.connectionId, sent.requestId).content, null);
  } finally {
    await expiry.relay.close();
  }
});

test("idle connections close and the connection cap stays on loopback", async () => {
  const clock = clockAt(2_000);
  const relayBox = await start({ clock, idleTimeoutMs: 1_000, maxConnections: 1 });
  try {
    const { ws } = await authed(relayBox.url);
    const blocked = new WebSocket(relayBox.url);
    const blockedDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cap_timeout")), 2000);
      blocked.once("error", () => { clearTimeout(timer); resolve("error"); });
      blocked.once("close", () => { clearTimeout(timer); resolve("close"); });
    });
    assert.equal(typeof await blockedDone, "string");
    const closed = new Promise((resolve) => ws.once("close", resolve));
    relayBox.relay.tick(2_000 + 1_000);
    await closed;
    assert.equal(relayBox.relay.stats().connections, 0);
  } finally {
    await relayBox.relay.close();
  }
});
