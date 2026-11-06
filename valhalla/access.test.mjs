import assert from "node:assert/strict";
import test from "node:test";
import { commandPayload, normalizeAccess, replyText } from "./access.js";

test("access is signed in only when the server says ok", () => {
  assert.deepEqual(normalizeAccess(null), { ok: false });
  assert.deepEqual(normalizeAccess({ ok: false, error: "session" }), { ok: false });
  assert.equal(normalizeAccess({ ok: true, id: "admin", role: "admin" }).leader, false);
  assert.equal(normalizeAccess({ ok: true, leader: true }).leader, true);
  assert.equal(normalizeAccess({ ok: true, leader: true }).admin, undefined);
});

test("a command uses conversation 0 and shows text only when completed", () => {
  assert.equal(commandPayload("hello").conversationId, "0");
  assert.equal(commandPayload("hello").app, "ai-workspace");
  assert.equal(replyText({ ok: true, status: "unavailable", text: null }), null);
  assert.equal(replyText({ ok: true, status: "completed", text: "  " }), null);
  assert.equal(replyText({ ok: true, status: "completed", text: "done" }), "done");
});
