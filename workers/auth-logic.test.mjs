import assert from "node:assert/strict";
import test from "node:test";
import { browserName, codeDecision, maskEmail, needSecondFactor, validEmail } from "./auth-logic.js";

test("email login needs a code, and a verified Google login does not", () => {
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: false, leader: false, codeThisLogin: false }), true);
  assert.equal(needSecondFactor({ codeThisLogin: true }), false);
  assert.equal(needSecondFactor({ codeThisLogin: false, googleVerified: true }), false);
});

test("a code allows five tries and then locks", () => {
  var now = 1_000;
  assert.equal(codeDecision(null, now), "missing");
  assert.equal(codeDecision({ exp: 999, attempts: 0 }, now), "expired");
  assert.equal(codeDecision({ exp: 2000, attempts: 5 }, now), "locked");
  assert.equal(codeDecision({ exp: 2000, attempts: 4 }, now), "ok");
});

test("email text stays plain", () => {
  assert.equal(maskEmail("ada@valhalla-app.xyz"), "a***@valhalla-app.xyz");
  assert.equal(validEmail("ada@valhalla-app.xyz"), true);
  assert.equal(validEmail("not an email"), false);
  assert.equal(browserName("Mozilla/5.0 Chrome/120"), "Chrome");
});
