import assert from "node:assert/strict";
import test from "node:test";
import { accessRequest, commandPayload, normalizeAccess, replyText, tasksRequest } from "./access.js";

test("the sign-in check uses the configured worker and omits cookies", () => {
  assert.equal(accessRequest({ AUTH_URL: "https://auth.example" }, ""), null);
  var call = accessRequest({ AUTH_URL: "https://auth.example" }, "token");
  assert.equal(call.url, "https://auth.example/auth/access");
  assert.equal(call.credentials, "omit");
  assert.equal(call.headers.authorization, "Bearer token");
  assert.equal(tasksRequest({ AGENT_API_URL: "" }, "token", {}), null);
});

test("access is signed in only when the server says ok", () => {
  assert.deepEqual(normalizeAccess(null), { ok: false });
  assert.deepEqual(normalizeAccess({ ok: false, error: "session" }), { ok: false });
  assert.equal(normalizeAccess({ ok: true, id: "admin", role: "admin" }).leader, false);
  assert.equal(normalizeAccess({ ok: true, leader: true }).leader, true);
  assert.equal(normalizeAccess({ ok: true, leader: true }).admin, undefined);
});

test("a command is chat and does not invent a conversation id", () => {
  assert.equal(commandPayload("hello").capability, "chat");
  assert.equal(commandPayload("hello").conversationId, undefined);
  assert.equal(commandPayload("hello", "server-id").conversationId, "server-id");
  assert.equal(commandPayload("hello").app, "ai-workspace");
  assert.equal(replyText({ ok: true, status: "unavailable", text: null }), null);
  assert.equal(replyText({ ok: true, status: "completed", text: "  " }), null);
  assert.equal(replyText({ ok: true, status: "completed", text: "done" }), "done");
});
