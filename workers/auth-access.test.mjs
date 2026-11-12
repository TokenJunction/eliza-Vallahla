import assert from "node:assert/strict";
import test from "node:test";
import worker from "./auth.js";

var SECRET = "a-test-secret-long-enough-for-hmac";
var EMAIL = "owner@example.test";
var encoder = new TextEncoder();

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function hash(text) {
  var bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

async function issue(payload) {
  var body = base64url(encoder.encode(JSON.stringify(payload)));
  var key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return body + "." + base64url(signature);
}

async function request(payload, rows) {
  var claims = Object.assign({
    did: "device",
    exp: Date.now() + 60000,
    code: false,
    google: false,
    sid: crypto.randomUUID(),
    sv: 1,
    use: "access"
  }, payload);
  rows["sess:" + claims.sid] = {
    sid: claims.sid,
    v: claims.sv,
    eh: claims.eh,
    did: claims.did,
    exp: claims.exp,
    code: claims.code === true,
    google: claims.google === true,
    use: claims.use
  };
  var token = await issue(claims);
  return {
    request: new Request("https://auth.example/auth/access", {
      headers: {
        authorization: "Bearer " + token,
        origin: "https://valhalla-app.xyz"
      }
    }),
    claims: claims
  };
}

function env(rows) {
  return {
    DEVICE_COOKIE_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "test-client",
    LEADER_EMAIL: EMAIL,
    AUTH_KV: {
      get: async function (key) {
        if (!Object.prototype.hasOwnProperty.call(rows, key)) return null;
        return JSON.stringify(rows[key]);
      }
    }
  };
}

test("returns Pro status from the server account record", async () => {
  var emailHash = await hash("member@example.test");
  var rows = { ["acct:" + emailHash]: { plan: "pro" } };
  var live = await request({ eh: emailHash, code: true }, rows);
  var response = await worker.fetch(live.request, env(rows));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "pro",
    subscriber: true,
    leader: false,
    subject: emailHash,
    sessionId: live.claims.sid,
    google: false,
    code: true,
    expires: live.claims.exp
  });
});

test("keeps free accounts locked and requires Google plus a verified code for owner access", async () => {
  var emailHash = await hash(EMAIL);
  var emailRows = {};
  var emailOnly = await worker.fetch((await request({ eh: emailHash, code: true }, emailRows)).request, env(emailRows));
  assert.equal((await emailOnly.json()).leader, false);

  var rows = {};
  var live = await request({ eh: emailHash, code: true, google: true }, rows);
  var response = await worker.fetch(live.request, env(rows));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    plan: "free",
    subscriber: false,
    leader: true,
    subject: emailHash,
    sessionId: live.claims.sid,
    google: true,
    code: true,
    expires: live.claims.exp
  });
});

test("a verified master admin alias is a leader only with Google and a code", async () => {
  var alias = "alias@example.test";
  var emailHash = await hash(alias);
  var settings = env({});
  settings.MASTER_ADMIN_EMAIL = alias;
  var withoutGoogle = await worker.fetch(await request({ eh: emailHash, code: true }), settings);
  assert.equal((await withoutGoogle.json()).leader, false);
  var response = await worker.fetch(await request({ eh: emailHash, code: true, google: true }), settings);
  assert.equal((await response.json()).leader, true);
});

test("rejects missing or invalid sessions", async () => {
  var missing = await worker.fetch(new Request("https://auth.example/auth/access"), env({}));
  assert.equal(missing.status, 401);
  var invalid = await worker.fetch(new Request("https://auth.example/auth/access", {
    headers: { authorization: "Bearer invalid.token" }
  }), env({}));
  assert.equal(invalid.status, 401);
});
