import assert from "node:assert/strict";
import test from "node:test";
import { browserName, codeDecision, maskEmail, needSecondFactor, validEmail } from "./auth-logic.js";

test("a known device still needs a code when the user always asks", () => {
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: true, leader: false, codeThisLogin: false }), true);
});

test("a leader needs a code even on a remembered device", () => {
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: false, leader: true, codeThisLogin: false }), true);
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: true, leader: true, codeThisLogin: true }), false);
});

test("a new device or a new network needs a code", () => {
  assert.equal(needSecondFactor({ knownDevice: false, knownIp: true, alwaysAsk: false, leader: false }), true);
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: false, alwaysAsk: false, leader: false }), true);
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: false, leader: false }), false);
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
