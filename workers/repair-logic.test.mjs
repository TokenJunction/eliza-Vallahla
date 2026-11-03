import assert from "node:assert/strict";
import test from "node:test";
import { actionFor, alertFor } from "./repair-logic.js";

test("a code change is only a proposal", () => {
  assert.equal(actionFor("needs a code change in wrangler"), "propose");
  assert.equal(actionFor("secret missing"), "propose");
});

test("safe runtime issues get a safe action", () => {
  assert.equal(actionFor("ticker cache stale"), "clear-cache");
  assert.equal(actionFor("chat model timed out"), "rotate-llm");
  assert.equal(actionFor("paper bot stuck"), "restart-paper");
  assert.equal(actionFor("webhook job failed"), "requeue");
});

test("three failures raise an alert", () => {
  assert.equal(alertFor(2), false);
  assert.equal(alertFor(3), true);
});
