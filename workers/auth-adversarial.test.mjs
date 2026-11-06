import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import worker from "./auth.js";
import { IDLE_MS, TOKEN_AUD, TOKEN_ISS, TOKEN_PURPOSE, asReplica, createAuthStore } from "./auth-store.mjs";

const secret = "test-device-cookie-secret";

function token(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function kv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
}

function env(extra = {}) {
  return {
    DEVICE_COOKIE_SECRET: secret,
    GOOGLE_CLIENT_ID: "test-client",
    LEADER_EMAIL: "owner@example.test",
    AUTH_KV: kv(),
    AUTH_DO: createAuthStore(),
    ...extra,
  };
}

function claims(extra) {
  return {
    iss: TOKEN_ISS,
    aud: TOKEN_AUD,
    purpose: TOKEN_PURPOSE,
    eh: "a".repeat(64),
    did: "device-a",
    sid: "11111111-1111-4111-8111-111111111111",
    sv: 1,
    ver: 1,
    exp: Date.now() + 60_000,
    code: true,
    google: true,
    ...extra,
  };
}

test("revoke does not apply another account's device", async () => {
  const box = env();
  const ada = claims();
  const bob = claims({ eh: "b".repeat(64), did: "device-b", sid: "22222222-2222-4222-8222-222222222222" });
  box.AUTH_DO.seed({ sid: ada.sid, eh: ada.eh, did: ada.did, exp: ada.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  box.AUTH_DO.seed({ sid: bob.sid, eh: bob.eh, did: bob.did, exp: bob.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  await box.AUTH_KV.put("acct:" + bob.eh, JSON.stringify({ devices: [{ id: bob.did }], ips: [], signins: [] }));
  const response = await worker.fetch(new Request("https://auth.example/auth/devices/revoke", {
    method: "POST",
    headers: { authorization: "Bearer " + token(bob), origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ id: ada.did }),
  }), box);
  assert.equal(response.status, 403);
  assert.ok(await box.AUTH_DO.readSession(ada));
  assert.ok(await box.AUTH_DO.readSession(bob));
});

test("revoking one device leaves the other session for that mailbox", async () => {
  const box = env();
  const phone = claims({ did: "phone", sid: "44444444-4444-4444-8444-444444444444" });
  const laptop = claims({ did: "laptop", sid: "55555555-5555-4555-8555-555555555555" });
  box.AUTH_DO.seed({ sid: phone.sid, eh: phone.eh, did: phone.did, exp: phone.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  box.AUTH_DO.seed({ sid: laptop.sid, eh: laptop.eh, did: laptop.did, exp: laptop.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  await box.AUTH_KV.put("acct:" + phone.eh, JSON.stringify({ devices: [{ id: phone.did }, { id: laptop.did }], ips: [], signins: [] }));
  const response = await worker.fetch(new Request("https://auth.example/auth/devices/revoke", {
    method: "POST",
    headers: { authorization: "Bearer " + token(laptop), origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ id: phone.did }),
  }), box);
  assert.equal(response.status, 200);
  assert.equal(await box.AUTH_DO.readSession(phone), null);
  assert.ok(await box.AUTH_DO.readSession(laptop));
  await box.AUTH_KV.put("sess:" + phone.sid, JSON.stringify({ sid: phone.sid, ver: 1, eh: phone.eh, did: phone.did, exp: phone.exp }));
  const replay = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token(phone), origin: "https://valhalla-app.xyz" },
  }), box);
  assert.equal(replay.status, 401);
});

test("email start cannot clear always-ask before a live session", async () => {
  const box = env();
  const eh = createHash("sha256").update("ada@example.test").digest("hex");
  await box.AUTH_KV.put("acct:" + eh, JSON.stringify({ devices: [], ips: [], signins: [], alwaysAsk: true }));
  const response = await worker.fetch(new Request("https://auth.example/auth/email/start", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.test", alwaysAsk: false }),
  }), box);
  assert.notEqual((await response.json()).error, "turnstile");
  const saved = JSON.parse(await box.AUTH_KV.get("acct:" + eh));
  assert.equal(saved.alwaysAsk, true);
});

test("one code id is consumed by the first caller only", async () => {
  const store = createAuthStore();
  await store.putCode("code:box:1");
  const results = await Promise.all([store.consumeCode("code:box:1"), store.consumeCode("code:box:1")]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("one Turnstile token cannot pass a second mailbox", async () => {
  const box = env({ TURNSTILE_SECRET: "turnstile-secret" });
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ success: true, action: "valhalla-signin", hostname: "valhalla-app.xyz" }) };
  };
  const first = await worker.fetch(new Request("https://auth.example/auth/email/start", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.test", turnstile: "widget-1" }),
  }), box);
  const second = await worker.fetch(new Request("https://auth.example/auth/email/start", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
    body: JSON.stringify({ email: "bob@example.test", turnstile: "widget-1" }),
  }), box);
  assert.notEqual((await first.json()).error, "turnstile");
  assert.equal(second.status, 403);
  assert.equal((await second.json()).error, "turnstile");
  assert.equal(calls.length, 1);
  globalThis.fetch = previous;
});

test("an idle session is rejected before its absolute expiry", async () => {
  const store = createAuthStore();
  const row = claims();
  store.seed({ sid: row.sid, eh: row.eh, did: row.did, exp: Date.now() + 60 * 60 * 1000, code: true, google: true, v: 1, lastSeen: Date.now() - IDLE_MS - 1000 });
  assert.equal(await store.readSession(row), null);
});

test("a replica snapshot is not session proof", async () => {
  const live = createAuthStore();
  const row = claims();
  live.seed({ sid: row.sid, eh: row.eh, did: row.did, exp: row.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  const box = env();
  box.AUTH_DO = asReplica(live);
  const response = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token(row), origin: "https://valhalla-app.xyz" },
  }), box);
  assert.equal(response.status, 401);
});

test("a KV session row is not proof when the strong store is missing", async () => {
  const box = env();
  delete box.AUTH_DO;
  const row = claims();
  await box.AUTH_KV.put("sess:" + row.sid, JSON.stringify({
    sid: row.sid, ver: 1, eh: row.eh, did: row.did, exp: row.exp, code: true, google: true, revoked: false,
  }));
  const response = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token(row), origin: "https://valhalla-app.xyz" },
  }), box);
  assert.equal(response.status, 401);
});

test("a token for another issuer or audience is rejected", async () => {
  const box = env();
  const row = claims({ aud: "other-service" });
  box.AUTH_DO.seed({ sid: row.sid, eh: row.eh, did: row.did, exp: row.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  const response = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token(row), origin: "https://valhalla-app.xyz" },
  }), box);
  assert.equal(response.status, 401);
  const other = env();
  const foreign = claims({ iss: "https://other.example", sid: "33333333-3333-4333-8333-333333333333" });
  other.AUTH_DO.seed({ sid: foreign.sid, eh: foreign.eh, did: foreign.did, exp: foreign.exp, code: true, google: true, v: 1, lastSeen: Date.now() });
  const foreignResponse = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer " + token(foreign), origin: "https://valhalla-app.xyz" },
  }), other);
  assert.equal(foreignResponse.status, 401);
});
