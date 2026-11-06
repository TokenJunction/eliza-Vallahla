import assert from "node:assert/strict";
import test from "node:test";
import { authorizeRequest, callbackCode, codeChallenge, sessionHandoff, tokenExchange } from "./google-auth.js";

var site = {
  SUPABASE_URL: "https://girltjnrrwlyeufrcors.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_example_public_key_000",
};

test("google authorize is a provider redirect and a typed email is not a session", async () => {
  var challenge = await codeChallenge("verifier-example");
  var call = authorizeRequest(site, "https://valhalla-app.xyz/app/", challenge);
  var url = new URL(call.url);
  assert.equal(url.searchParams.get("provider"), "google");
  assert.equal(url.searchParams.get("redirect_to"), "https://valhalla-app.xyz/app/");
  assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  assert.equal(authorizeRequest({ SUPABASE_URL: "https://evil.example", SUPABASE_ANON_KEY: site.SUPABASE_ANON_KEY }, "https://valhalla-app.xyz/app/", challenge), null);
  assert.equal(sessionHandoff({ provider: "google", supabaseUrl: site.SUPABASE_URL }).error, "incomplete");
  assert.equal(sessionHandoff({ email: "ada@gmail.com" }).error, "incomplete");
  assert.equal(sessionHandoff({ accessToken: "x".repeat(24) }).ok, true);
  assert.equal(callbackCode("?error=access_denied").ok, false);
  var exchange = tokenExchange(site, "auth-code", "verifier-example");
  assert.equal(JSON.parse(exchange.body).auth_code, "auth-code");
  assert.equal(exchange.headers.apikey, site.SUPABASE_ANON_KEY);
});
