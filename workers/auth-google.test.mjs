import assert from "node:assert/strict";
import test from "node:test";
import worker from "./auth.js";
import { createAuthStore } from "./auth-store.mjs";

const secret = "test-device-cookie-secret";
const client = "test-client.apps.googleusercontent.com";

function env() {
  const values = new Map();
  return {
    AUTH_KV: {
      async get(key) { return values.has(key) ? values.get(key) : null; },
      async put(key, value) { values.set(key, String(value)); },
      async delete(key) { values.delete(key); }
    },
    AUTH_DO: createAuthStore(),
    DEVICE_COOKIE_SECRET: secret,
    GOOGLE_CLIENT_ID: client,
    LEADER_EMAIL: "leader@example.test"
  };
}

function tokenInfo(extra = {}) {
  return {
    ok: true,
    json: async () => ({
      aud: client,
      iss: "https://accounts.google.com",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      email: "ada@gmail.com",
      email_verified: "true",
      sub: "109876543210",
      nonce: extra.nonce || "",
      scope: "openid email profile",
      name: "Ada"
    })
  };
}

test("a verified Gmail token opens a customer session and a second nonce use fails", async () => {
  const box = env();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url).startsWith("https://oauth2.googleapis.com/tokeninfo"), true);
    return tokenInfo({ nonce: box.nonce });
  };
  const nonceResponse = await worker.fetch(new Request("https://auth.example/auth/google/nonce", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: "{}"
  }), box);
  const issued = await nonceResponse.json();
  box.nonce = issued.nonce;
  const first = await worker.fetch(new Request("https://auth.example/auth/google", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ credential: "header.payload.sig", nonce: issued.nonce })
  }), box);
  const body = await first.json();
  assert.equal(first.status, 200);
  assert.equal(body.needCode, false);
  assert.equal(body.supabaseAuthUid, null);
  assert.equal(body.googleSub, "109876543210");
  assert.equal(typeof body.session, "string");
  const second = await worker.fetch(new Request("https://auth.example/auth/google", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: JSON.stringify({ credential: "header.payload.sig", nonce: issued.nonce })
  }), box);
  assert.equal(second.status, 401);
  assert.equal((await second.json()).error, "nonce");
  globalThis.fetch = previous;
});

test("Google sign-in stays unavailable when the session store is missing", async () => {
  const box = env();
  delete box.AUTH_DO;
  const response = await worker.fetch(new Request("https://auth.example/auth/google/nonce", {
    method: "POST",
    headers: { origin: "https://valhalla-app.xyz", "content-type": "application/json" },
    body: "{}"
  }), box);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "auth-store-disabled");
});
