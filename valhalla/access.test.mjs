import assert from "node:assert/strict";
import test from "node:test";
import { accessRequest, commandPayload, healthReady, LIVE_TASK_CAPABILITIES, normalizeAccess, publicWebUrl, replyText, serializeTaskBody, taskContractBlock, tasksRequest } from "./access.js";

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

test("a task request body is JSON, not an object string", async () => {
  var payload = commandPayload("hello", "server-1");
  payload.capability = "view";
  var call = tasksRequest({ AGENT_API_URL: "https://api.example" }, "token", payload);
  var request = new Request(call.url, {
    method: "POST",
    headers: call.headers,
    body: call.body,
  });
  var raw = await request.text();
  assert.equal(raw.includes("[object Object]"), false);
  assert.deepEqual(JSON.parse(raw), payload);
  assert.equal(call.body, serializeTaskBody(payload));
});

test("chat is not sent as view or reasoning, and a missing conversation id is not posted", () => {
  assert.equal(LIVE_TASK_CAPABILITIES.includes("chat"), false);
  assert.equal(taskContractBlock(commandPayload("hello")), "The server has not issued a conversation id. The command was not sent.");
  assert.match(taskContractBlock(commandPayload("hello", "server-1")), /not sent as view or reasoning/);
  assert.equal(tasksRequest({ AGENT_API_URL: "https://api.example" }, "token", commandPayload("hello", "server-1")), null);
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

test("health is ready only from ready or component evidence", () => {
  assert.equal(healthReady({ status: "ok" }), false);
  assert.equal(healthReady({ ready: true }), true);
  assert.equal(healthReady({ components: {} }), false);
  assert.equal(healthReady({ components: { api: "ok", db: true } }), true);
  assert.equal(healthReady({ components: { api: "down" } }), false);
});

test("the browser address rejects scripts, local nets, and keys", () => {
  assert.equal(publicWebUrl("javascript:alert(1)").ok, false);
  assert.equal(publicWebUrl("data:text/html,hi").ok, false);
  assert.equal(publicWebUrl("https://user:pass@example.com/").ok, false);
  assert.equal(publicWebUrl("https://127.0.0.1/admin").ok, false);
  assert.equal(publicWebUrl("https://10.0.0.4/").ok, false);
  assert.equal(publicWebUrl("https://example.com/?token=abc").ok, false);
  assert.equal(publicWebUrl("http://example.com/page").http, true);
  var safe = publicWebUrl("https://example.com/guide");
  assert.equal(safe.ok, true);
  assert.equal(safe.display, "https://example.com/guide");
});
