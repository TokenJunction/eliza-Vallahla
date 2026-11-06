import assert from "node:assert/strict";
import test from "node:test";
import { browserName, codeDecision, maskEmail, needSecondFactor, sessionApiCookies, validEmail } from "./auth-logic.js";

test("every login needs a code until this login has entered one", () => {
  assert.equal(needSecondFactor({ knownDevice: true, knownIp: true, alwaysAsk: false, leader: false, codeThisLogin: false }), true);
  assert.equal(needSecondFactor({ codeThisLogin: true }), false);
  assert.equal(needSecondFactor({ secondFactor: false, codeThisLogin: false }), true);
  assert.equal(needSecondFactor({ secondFactor: false, knownDevice: true, alwaysAsk: false, codeThisLogin: false }), false);
  assert.equal(needSecondFactor({ secondFactor: false, knownDevice: true, alwaysAsk: true, codeThisLogin: false }), true);
  assert.equal(needSecondFactor({ secondFactor: true, codeThisLogin: false }), true);
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

test("the API session cookie is host-only, Lax, and not partitioned", () => {
  const cookies = sessionApiCookies("session-token", "csrf-token").join("\n");
  assert.match(cookies, /vh_session=session-token; HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=43200/);
  assert.match(cookies, /vh_csrf=csrf-token; Secure; SameSite=Lax; Path=\/api; Max-Age=43200/);
  assert.equal(cookies.includes("Partitioned"), false);
  assert.equal(cookies.includes("Domain="), false);
});
