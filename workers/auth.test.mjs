import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import worker from "./auth.js";

var secret = "test-device-cookie-secret";
var leaderEmail = "leader@example.test";
var leaderHash = createHash("sha256").update(leaderEmail).digest("hex");

function token(payload) {
  var encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  var signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

function request(path, method, body, session) {
  return new Request("https://auth.test" + path, {
    method: method || "GET",
    headers: {
      origin: "https://valhalla-app.xyz",
      "content-type": "application/json",
      authorization: session ? "Bearer " + session : ""
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function setup() {
  var values = new Map();
  return {
    env: {
      AUTH_KV: {
        get: async (key) => values.get(key) || null,
        put: async (key, value) => values.set(key, String(value)),
        delete: async (key) => values.delete(key)
      },
      DEVICE_COOKIE_SECRET: secret,
      GOOGLE_CLIENT_ID: "test-client",
      LEADER_EMAIL: leaderEmail
    },
    values: values
  };
}

function session(emailHash, code, google) {
  return token({ eh: emailHash, did: "device", exp: Date.now() + 60000, code: code, google: google === true });
}

test("chat configuration is public but restricted to approved OpenAI models", async () => {
  var state = setup();
  var response = await worker.fetch(request("/auth/chat-config"), state.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    provider: "openai",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"]
  });
});

test("only a Google-authenticated, code-verified session for the configured email gets manager access", async () => {
  var state = setup();
  var other = await worker.fetch(request(
    "/auth/leader", "POST", { email: leaderEmail }, session("other-hash", true)
  ), state.env);
  assert.equal((await other.json()).role, "member");

  var unverified = await worker.fetch(request("/auth/leader", "POST", {}, session(leaderHash, false, true)), state.env);
  assert.equal((await unverified.json()).role, "member");

  var emailOnly = await worker.fetch(request("/auth/leader", "POST", {}, session(leaderHash, true)), state.env);
  assert.equal((await emailOnly.json()).role, "member");

  var owner = await worker.fetch(request("/auth/leader", "POST", {}, session(leaderHash, true, true)), state.env);
  assert.equal((await owner.json()).role, "leader");
});

test("model changes require the verified owner session and an approved model", async () => {
  var state = setup();
  var unauthorized = await worker.fetch(request(
    "/auth/chat-config", "POST", { model: "gpt-4.1-mini" }, session("other-hash", true)
  ), state.env);
  assert.equal(unauthorized.status, 403);

  var unsupported = await worker.fetch(request(
    "/auth/chat-config", "POST", { model: "meta-llama" }, session(leaderHash, true, true)
  ), state.env);
  assert.equal(unsupported.status, 400);

  var accepted = await worker.fetch(request(
    "/auth/chat-config", "POST", { model: "gpt-4.1-mini" }, session(leaderHash, true, true)
  ), state.env);
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(await state.values.get("manager:chat-config")).model, "gpt-4.1-mini");
});

test("engagement collection requires analytics consent and stores aggregate event counts", async () => {
  var state = setup();
  var owner = session(leaderHash, true, true);
  var denied = await worker.fetch(request(
    "/auth/engagement", "POST", { event: "page_view", analyticsConsent: false }, owner
  ), state.env);
  assert.equal(denied.status, 403);

  var accepted = await worker.fetch(request(
    "/auth/engagement", "POST", { event: "page_view", analyticsConsent: true }, owner
  ), state.env);
  assert.equal(accepted.status, 202);

  var report = await worker.fetch(request("/auth/engagement", "GET", undefined, owner), state.env);
  var body = await report.json();
  assert.equal(body.approximate, true);
  assert.equal(body.days[6].page_view, 1);
});

test("a typed email is not a Google session, and a Supabase Google user gets a session without leader", async () => {
  var state = setup();
  state.env.SUPABASE_URL = "https://girltjnrrwlyeufrcors.supabase.co";
  state.env.SUPABASE_ANON_KEY = "sb_publishable_example_public_key_000";
  var incomplete = await worker.fetch(request("/auth/supabase", "POST", {
    provider: "google",
    supabaseUrl: state.env.SUPABASE_URL,
  }), state.env);
  assert.equal(incomplete.status, 400);
  assert.equal((await incomplete.json()).error, "incomplete");

  var previous = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    assert.equal(String(url), state.env.SUPABASE_URL + "/auth/v1/user");
    assert.equal(options.headers.authorization, "Bearer supabase-user-access-token");
    return new Response(JSON.stringify({
      email: leaderEmail,
      app_metadata: { provider: "google" },
      user_metadata: { full_name: "Ada" },
    }), { status: 200 });
  };
  try {
    var accepted = await worker.fetch(request("/auth/supabase", "POST", {
      accessToken: "supabase-user-access-token",
    }), state.env);
    var body = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.session, "string");
    var role = await worker.fetch(request("/auth/leader", "POST", {}, body.session), state.env);
    assert.equal((await role.json()).role, "member");
  } finally {
    globalThis.fetch = previous;
  }
});
