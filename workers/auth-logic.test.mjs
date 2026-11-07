import assert from "node:assert/strict";
import test from "node:test";
import { browserName, codeDecision, maskEmail, needSecondFactor, opaqueId, sensitiveSignIn, sessionMatches, turnstileEnforced, validEmail } from "./auth-logic.js";

test("extra code is required for always-ask, unknown, revoked, or missing base proof", () => {
  var known = { knownDevice: true, alwaysAsk: false, leader: false, revoked: false, baseVerified: true, codeThisLogin: false };
  assert.equal(needSecondFactor(known), false);
  assert.equal(needSecondFactor(Object.assign({}, known, { alwaysAsk: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { knownDevice: false })), true);
  assert.equal(needSecondFactor({ alwaysAsk: false, knownDevice: false, baseVerified: true }), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { revoked: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { leader: true })), true);
  assert.equal(needSecondFactor(Object.assign({}, known, { baseVerified: false })), true);
  assert.equal(needSecondFactor({ codeThisLogin: true, knownDevice: false, baseVerified: false }), false);
});

test("a code allows five tries and then locks", () => {
  var now = 1_000;
  assert.equal(codeDecision(null, now), "missing");
  assert.equal(codeDecision({ exp: 999, attempts: 0 }, now), "expired");
  assert.equal(codeDecision({ exp: 2000, attempts: 5 }, now), "locked");
  assert.equal(codeDecision({ exp: 2000, attempts: 4 }, now), "ok");
});

test("a live session must match the signed claims and the same expiry", () => {
  var now = 5_000;
  var record = {
    sid: "11111111-1111-4111-8111-111111111111",
    v: 1,
    eh: "a".repeat(64),
    did: "device-1",
    exp: 9_000,
    code: true,
    google: false,
    use: "access"
  };
  var claims = {
    sid: record.sid,
    sv: 1,
    eh: record.eh,
    did: record.did,
    exp: record.exp,
    code: true,
    google: false,
    use: "access"
  };
  assert.equal(sessionMatches(record, claims, now), "ok");
  assert.equal(sessionMatches(null, claims, now), "missing");
  assert.equal(sessionMatches(record, Object.assign({}, claims, { sv: 2 }), now), "revoked");
  assert.equal(sessionMatches(record, Object.assign({}, claims, { eh: "b".repeat(64) }), now), "mismatch");
  assert.equal(sessionMatches(record, Object.assign({}, claims, { exp: 8_000 }), now), "mismatch");
  assert.equal(sessionMatches(Object.assign({}, record, { exp: 4_000 }), Object.assign({}, claims, { exp: 4_000 }), now), "expired");
  assert.equal(opaqueId("a".repeat(32)), "a".repeat(32));
  assert.equal(opaqueId("not-a-nonce"), "");
  assert.equal(turnstileEnforced(""), false);
  assert.equal(turnstileEnforced("secret"), true);
  assert.equal(sensitiveSignIn("/auth/email/start", "POST"), true);
  assert.equal(sensitiveSignIn("/auth/access", "GET"), false);
});

test("email text stays plain", () => {
  assert.equal(maskEmail("ada@valhalla-app.xyz"), "a***@valhalla-app.xyz");
  assert.equal(validEmail("ada@valhalla-app.xyz"), true);
  assert.equal(validEmail("not an email"), false);
  assert.equal(browserName("Mozilla/5.0 Chrome/120"), "Chrome");
});
