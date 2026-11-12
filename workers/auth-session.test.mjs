import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import worker from "./auth.js";

var secret = "test-device-cookie-secret";
var clientId = "test-client";
var leaderEmail = "leader@example.test";

function kvStore() {
  var values = new Map();
  var ttls = new Map();
  return {
    values: values,
    ttls: ttls,
    binding: {
      get: async function (key) { return values.has(key) ? values.get(key) : null; },
      put: async function (key, value, options) {
        values.set(key, String(value));
        if (options && options.expirationTtl) ttls.set(key, options.expirationTtl);
      },
      delete: async function (key) {
        values.delete(key);
        ttls.delete(key);
      }
    }
  };
}

function harness(extra) {
  var sent = [];
  var store = kvStore();
  return {
    store: store,
    sent: sent,
    env: Object.assign({
      AUTH_KV: store.binding,
      DEVICE_COOKIE_SECRET: secret,
      GOOGLE_CLIENT_ID: clientId,
      LEADER_EMAIL: leaderEmail,
      EMAIL: {
        send: async function (message) { sent.push(message); }
      }
    }, extra || {})
  };
}

function call(path, method, body, env, session, cookie, extraHeaders) {
  var headers = {
    origin: "https://valhalla-app.xyz",
    "content-type": "application/json",
    "CF-Connecting-IP": "198.51.100.10"
  };
  if (session) headers.authorization = "Bearer " + session;
  if (cookie) headers.cookie = "vh_device=" + cookie;
  Object.keys(extraHeaders || {}).forEach(function (name) { headers[name] = extraHeaders[name]; });
  return worker.fetch(new Request("https://auth.test" + path, {
    method: method || "GET",
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

async function nonce(env) {
  var response = await call("/auth/nonce", "GET", undefined, env);
  assert.equal(response.status, 200);
  var body = await response.json();
  assert.equal(body.nonce.length, 32);
  return body.nonce;
}

function codeFrom(sent) {
  var match = String(sent[sent.length - 1] && sent[sent.length - 1].text || "").match(/code is (\d{6})/);
  assert.ok(match, "sign-in code was not in the mail text");
  return match[1];
}

function cookieFrom(response) {
  var first = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.equal(first.indexOf("vh_device="), 0);
  return first.slice("vh_device=".length);
}

async function emailLogin(h, email, cookie) {
  var started = await call("/auth/email/start", "POST", { email: email, nonce: await nonce(h.env), alwaysAsk: false }, h.env);
  assert.equal(started.status, 200);
  var startBody = await started.json();
  assert.equal(startBody.email, undefined);
  assert.equal(JSON.stringify(startBody).indexOf(email), -1);
  assert.match(startBody.hint, /@/);
  var verified = await call("/auth/email/verify", "POST", {
    pending: startBody.pending,
    code: codeFrom(h.sent),
    email: "other@example.test",
    name: "Admin",
    nonce: await nonce(h.env)
  }, h.env, "", cookie || "");
  assert.equal(verified.status, 200);
  var body = await verified.json();
  assert.ok(body.session);
  assert.equal(body.email, undefined);
  assert.equal(body.name, undefined);
  return { body: body, cookie: cookieFrom(verified), pending: startBody.pending };
}

function forge(payload) {
  var encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  var signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

test("email codes reject a forged code and a second use of the same code", async () => {
  var h = harness();
  var firstNonce = await nonce(h.env);
  var started = await call("/auth/email/start", "POST", {
    email: "ada@example.test",
    nonce: firstNonce
  }, h.env);
  assert.equal(started.status, 200);
  var startBody = await started.json();
  var reused = await call("/auth/email/start", "POST", {
    email: "ada@example.test",
    nonce: firstNonce
  }, h.env);
  assert.equal(reused.status, 401);
  assert.equal((await reused.json()).error, "nonce");

  var wrong = await call("/auth/email/verify", "POST", {
    pending: startBody.pending,
    code: "000000",
    nonce: await nonce(h.env)
  }, h.env);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "code");

  var first = await call("/auth/email/verify", "POST", {
    pending: startBody.pending,
    code: codeFrom(h.sent),
    nonce: await nonce(h.env)
  }, h.env);
  assert.equal(first.status, 200);
  var again = await call("/auth/email/verify", "POST", {
    pending: startBody.pending,
    code: codeFrom(h.sent),
    nonce: await nonce(h.env)
  }, h.env);
  assert.equal(again.status, 401);
  assert.equal((await again.json()).error, "missing");
});

test("a signed bearer without a live session is rejected, including a forged subject", async () => {
  var h = harness();
  var login = await emailLogin(h, "ada@example.test");
  var parts = login.body.session.split(".");
  parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === "a" ? "b" : "a");
  var tampered = await call("/auth/access", "GET", undefined, h.env, parts.join("."));
  assert.equal(tampered.status, 401);

  var forged = forge({
    eh: "ab".repeat(32),
    did: "device",
    exp: Date.now() + 60000,
    code: true,
    google: true,
    sid: crypto.randomUUID(),
    sv: 1,
    use: "access"
  });
  var stateless = await call("/auth/access", "GET", undefined, h.env, forged);
  assert.equal(stateless.status, 401);

  var live = JSON.parse(Buffer.from(login.body.session.split(".")[0], "base64url").toString());
  var swapped = forge(Object.assign({}, live, { eh: "cd".repeat(32) }));
  var mismatch = await call("/auth/access", "GET", undefined, h.env, swapped);
  assert.equal(mismatch.status, 401);
  var cookieAsBearer = await call("/auth/access", "GET", undefined, h.env, login.cookie);
  assert.equal(cookieAsBearer.status, 401);
});

test("a live access token can be read twice and fails after logout", async () => {
  var h = harness();
  var login = await emailLogin(h, "ada@example.test");
  var first = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  var second = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).code, true);
  var loggedOut = await call("/auth/logout", "POST", {}, h.env, login.body.session, login.cookie);
  assert.equal(loggedOut.status, 200);
  var after = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  assert.equal(after.status, 401);
});

test("revoking a device rejects that device bearer", async () => {
  var h = harness();
  var login = await emailLogin(h, "ada@example.test");
  var devices = await call("/auth/devices", "GET", undefined, h.env, login.body.session);
  var listed = await devices.json();
  assert.equal(listed.devices.length, 1);
  assert.equal(JSON.stringify(listed).indexOf("accessSid"), -1);
  var claims = JSON.parse(Buffer.from(login.body.session.split(".")[0], "base64url").toString());
  var saved = h.store.values.get("sess:" + claims.sid);
  var revoked = await call("/auth/devices/revoke", "POST", { id: listed.devices[0].id }, h.env, login.body.session);
  assert.equal(revoked.status, 200);
  var after = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  assert.equal(after.status, 401);
  h.store.values.set("sess:" + claims.sid, saved);
  var cached = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  assert.equal(cached.status, 401);
  assert.ok(h.store.ttls.get("revoked:" + listed.devices[0].id) >= 60);
});

test("the next email proof rotates the access token", async () => {
  var h = harness();
  var first = await emailLogin(h, "ada@example.test");
  var second = await emailLogin(h, "ada@example.test", first.cookie);
  assert.notEqual(first.body.session, second.body.session);
  assert.equal((await call("/auth/access", "GET", undefined, h.env, first.body.session)).status, 401);
  assert.equal((await call("/auth/access", "GET", undefined, h.env, second.body.session)).status, 200);
  assert.equal(second.body.redirect, "/dashboard/analytics/");
});

test("google proof is single use and leader access still needs Google plus the email code", async (t) => {
  var h = harness();
  t.mock.method(globalThis, "fetch", async function (url) {
    if (String(url).indexOf("https://oauth2.googleapis.com/tokeninfo") !== 0) throw new Error("unexpected fetch");
    return Response.json({
      aud: clientId,
      iss: "https://accounts.google.com",
      exp: String(Math.floor(Date.now() / 1000) + 900),
      email_verified: "true",
      email: leaderEmail,
      name: "Leader",
      scope: "openid email"
    });
  });
  var credential = "google-id-token-one";
  var first = await call("/auth/google", "POST", { credential: credential, nonce: await nonce(h.env), alwaysAsk: false }, h.env);
  assert.equal(first.status, 200);
  var googleBody = await first.json();
  assert.equal(googleBody.needCode, true);
  var replay = await call("/auth/google", "POST", { credential: credential, nonce: await nonce(h.env) }, h.env);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "replay");
  assert.equal(googleBody.email, undefined);
  assert.equal(googleBody.name, undefined);
  assert.equal(googleBody.picture, undefined);
  var verified = await call("/auth/email/verify", "POST", {
    pending: googleBody.pending,
    code: codeFrom(h.sent),
    nonce: await nonce(h.env)
  }, h.env);
  assert.equal(verified.status, 200);
  var body = await verified.json();
  assert.equal(body.redirect, "/admin/master-control/");
  var access = await call("/auth/access", "GET", undefined, h.env, body.session);
  assert.equal((await access.json()).leader, true);

  var emailOnlyHarness = harness();
  var emailOnly = await emailLogin(emailOnlyHarness, leaderEmail);
  assert.equal(emailOnly.body.redirect, "/dashboard/analytics/");
  var member = await call("/auth/access", "GET", undefined, emailOnlyHarness.env, emailOnly.body.session);
  assert.equal((await member.json()).leader, false);
  t.mock.restoreAll();
});

test("Turnstile is skipped until configured and then fails closed", async (t) => {
  var open = harness();
  t.mock.method(globalThis, "fetch", async function () { throw new Error("siteverify must not be called"); });
  var skipped = await call("/auth/human", "POST", {}, open.env);
  assert.equal(skipped.status, 200);
  assert.equal((await skipped.json()).enforced, false);
  t.mock.restoreAll();

  var closed = harness({ TURNSTILE_SECRET: "turnstile-secret" });
  var missing = await call("/auth/human", "POST", {}, closed.env);
  assert.equal(missing.status, 403);
  var blocked = await call("/auth/email/start", "POST", {
    email: "ada@example.test",
    nonce: await nonce(closed.env)
  }, closed.env);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, "turnstile");

  t.mock.method(globalThis, "fetch", async function () { throw new Error("down"); });
  var failed = await call("/auth/human", "POST", { token: "token-down" }, closed.env);
  assert.equal(failed.status, 403);
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async function () {
    return Response.json({ success: false });
  });
  var rejected = await call("/auth/human", "POST", { token: "token-no" }, closed.env);
  assert.equal(rejected.status, 403);
  t.mock.restoreAll();

  var seen = 0;
  t.mock.method(globalThis, "fetch", async function (url) {
    seen += 1;
    assert.match(String(url), /siteverify/);
    return Response.json({ success: true, action: "valhalla-signin", hostname: "valhalla-app.xyz" });
  });
  var passed = await call("/auth/human", "POST", { token: "token-yes" }, closed.env);
  assert.equal(passed.status, 200);
  var human = (await passed.json()).human;
  var started = await call("/auth/email/start", "POST", {
    email: "ada@example.test",
    nonce: await nonce(closed.env),
    human: human
  }, closed.env);
  assert.equal(started.status, 200);
  assert.equal(seen, 1);
});

test("added auth state expires and does not store the mailbox or the signing secret", async () => {
  var h = harness();
  await emailLogin(h, "ada@example.test");
  var keys = Array.from(h.store.values.keys());
  assert.ok(keys.some(function (key) { return key.indexOf("sess:") === 0; }));
  keys.forEach(function (key) {
    if (key.indexOf("sess:") === 0 || key.indexOf("nonce:") === 0) {
      assert.ok(h.store.ttls.get(key) >= 60, key);
    }
    assert.equal(key.indexOf("ada@example.test"), -1);
    assert.equal(key.indexOf(secret), -1);
    assert.equal(String(h.store.values.get(key)).indexOf("ada@example.test"), -1);
    assert.equal(String(h.store.values.get(key)).indexOf(secret), -1);
  });
});

function tokenClaims(token) {
  return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString());
}

function googleToken(email) {
  return async function (url) {
    if (String(url).indexOf("https://oauth2.googleapis.com/tokeninfo") !== 0) throw new Error("unexpected fetch");
    return Response.json({
      aud: clientId,
      iss: "https://accounts.google.com",
      exp: String(Math.floor(Date.now() / 1000) + 900),
      email_verified: "true",
      email: email,
      name: "Should Not Leak",
      picture: "https://example.test/photo.png",
      scope: "openid email"
    });
  };
}

test("the code opt-out skips only a known device and network", async (t) => {
  var h = harness();
  t.mock.method(globalThis, "fetch", googleToken("ada@example.test"));
  var first = await emailLogin(h, "ada@example.test");
  var defaults = await call("/auth/devices", "GET", undefined, h.env, first.body.session);
  assert.equal((await defaults.json()).secondFactor, true);
  var preference = await call("/auth/security", "POST", { secondFactor: false }, h.env, first.body.session);
  assert.equal(preference.status, 200);
  assert.equal((await preference.json()).secondFactor, false);
  var known = await call("/auth/google", "POST", {
    credential: "google-known",
    nonce: await nonce(h.env),
    alwaysAsk: false,
    name: "Admin"
  }, h.env, "", first.cookie);
  assert.equal(known.status, 200);
  var knownBody = await known.json();
  assert.equal(knownBody.needCode, false);
  assert.equal(knownBody.name, undefined);
  assert.equal(knownBody.picture, undefined);
  assert.match(knownBody.hint, /^a\*\*\*@example\.test$/);
  var access = await call("/auth/access", "GET", undefined, h.env, knownBody.session);
  var accessBody = await access.json();
  assert.equal(accessBody.google, true);
  assert.equal(accessBody.code, false);
  assert.equal(accessBody.leader, false);

  var newNetwork = await call("/auth/google", "POST", {
    credential: "google-new-network",
    nonce: await nonce(h.env),
    alwaysAsk: false
  }, h.env, "", first.cookie, { "CF-Connecting-IP": "198.51.100.27" });
  var newNetworkBody = await newNetwork.json();
  assert.equal(newNetworkBody.needCode, true);
  assert.equal(newNetworkBody.session, undefined);

  var unknown = await call("/auth/google", "POST", {
    credential: "google-unknown",
    nonce: await nonce(h.env),
    alwaysAsk: false
  }, h.env);
  assert.equal((await unknown.json()).needCode, true);

  var asked = await call("/auth/google", "POST", {
    credential: "google-always",
    nonce: await nonce(h.env),
    alwaysAsk: true
  }, h.env, "", cookieFrom(known));
  assert.equal((await asked.json()).needCode, true);
  t.mock.restoreAll();
});

test("a leader still needs Google plus the email code on a recognized device", async (t) => {
  var h = harness();
  t.mock.method(globalThis, "fetch", googleToken(leaderEmail));
  var first = await emailLogin(h, leaderEmail);
  var preference = await call("/auth/security", "POST", { secondFactor: false }, h.env, first.body.session);
  assert.equal(preference.status, 200);
  var again = await call("/auth/google", "POST", {
    credential: "google-leader-known",
    nonce: await nonce(h.env),
    alwaysAsk: false
  }, h.env, "", first.cookie);
  var body = await again.json();
  assert.equal(body.needCode, true);
  assert.equal(body.session, undefined);
  t.mock.restoreAll();
});

test("an expired device cookie and a corrupted session version do not pass", async (t) => {
  var h = harness();
  t.mock.method(globalThis, "fetch", googleToken("ada@example.test"));
  var login = await emailLogin(h, "ada@example.test");
  var device = tokenClaims(login.cookie);
  device.exp = Date.now() - 5000;
  h.store.values.set("sess:" + device.sid, JSON.stringify({
    sid: device.sid,
    v: 1,
    eh: device.eh,
    did: device.did,
    exp: device.exp,
    code: false,
    google: false,
    use: "device"
  }));
  var expired = await call("/auth/google", "POST", {
    credential: "google-expired-device",
    nonce: await nonce(h.env),
    alwaysAsk: false
  }, h.env, "", forge(device));
  assert.equal((await expired.json()).needCode, true);

  var access = tokenClaims(login.body.session);
  var stored = JSON.parse(h.store.values.get("sess:" + access.sid));
  stored.v = 9;
  h.store.values.set("sess:" + access.sid, JSON.stringify(stored));
  var broken = await call("/auth/access", "GET", undefined, h.env, login.body.session);
  assert.equal(broken.status, 401);
  t.mock.restoreAll();
});

test("configured Turnstile rejects a replay, the wrong action, and the wrong host", async (t) => {
  var closed = harness({ TURNSTILE_SECRET: "turnstile-secret" });
  var calls = 0;
  t.mock.method(globalThis, "fetch", async function () {
    calls += 1;
    return Response.json({ success: true, action: "valhalla-signin", hostname: "valhalla-app.xyz" });
  });
  assert.equal((await call("/auth/human", "POST", { token: "once" }, closed.env)).status, 200);
  assert.equal((await call("/auth/human", "POST", { token: "once" }, closed.env)).status, 403);
  assert.equal(calls, 1);
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async function () {
    return Response.json({ success: true, action: "other", hostname: "valhalla-app.xyz" });
  });
  assert.equal((await call("/auth/human", "POST", { token: "bad-action" }, closed.env)).status, 403);
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async function () {
    return Response.json({ success: true, action: "valhalla-signin", hostname: "evil.example" });
  });
  assert.equal((await call("/auth/human", "POST", { token: "bad-host" }, closed.env)).status, 403);
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async function () {
    return Response.json({
      success: true,
      action: "valhalla-signin",
      hostname: "www.valhalla-app.xyz",
      "error-codes": ["timeout-or-duplicate"]
    });
  });
  assert.equal((await call("/auth/human", "POST", { token: "duplicate-from-cloudflare" }, closed.env)).status, 403);
});
