import assert from "node:assert/strict";
import test from "node:test";
import { accessRequest, commandPayload, healthReady, LIVE_TASK_CAPABILITIES, normalizeAccess, publicWebUrl, replyText, serializeTaskBody, stopState, taskContractBlock, taskHistoryRequest, taskIdOf, taskReadRequest, taskState, tasksRequest } from "./access.js";

test("the sign-in check uses an allowlisted worker and omits cookies", () => {
  assert.equal(accessRequest({ AUTH_URL: "https://auth.example" }, "token"), null);
  assert.equal(accessRequest({ AUTH_URL: "https://evil.example" }, "token", "valhalla-app.xyz"), null);
  var call = accessRequest({ AUTH_URL: "https://auth.valhalla-app.xyz" }, "token");
  assert.equal(call.url, "https://auth.valhalla-app.xyz/auth/access");
  assert.equal(call.credentials, "omit");
  assert.equal(call.headers.authorization, "Bearer token");
  assert.equal(tasksRequest({ AGENT_API_URL: "" }, "token", {}), null);
  assert.equal(tasksRequest({ AGENT_API_URL: "https://evil.example" }, "token", { capability: "view", app: "ai-workspace", text: "hi", tool: "none" }), null);
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
  var call = tasksRequest({ AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", payload);
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

test("chat is not sent as view or reasoning, and a synthetic conversation id is not posted", () => {
  assert.equal(LIVE_TASK_CAPABILITIES.includes("chat"), false);
  assert.match(taskContractBlock(commandPayload("hello", "0")), /not from the server/);
  assert.match(taskContractBlock(commandPayload("hello", "LOCAL_CURATED")), /not from the server/);
  assert.match(taskContractBlock(commandPayload("hello", "server-1")), /not sent as view or reasoning/);
  assert.equal(tasksRequest({ AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", commandPayload("hello", "server-1")), null);
  var view = commandPayload("hello");
  view.capability = "view";
  assert.equal(taskContractBlock(view), "");
  assert.equal(taskHistoryRequest({ AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", "0"), null);
  assert.equal(taskHistoryRequest({ AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", "server-1").url, "https://eliza-valhalla.onrender.com/api/v1/tasks?conversationId=server-1");
});

test("a command is chat and does not invent a conversation id", () => {
  assert.equal(commandPayload("hello").capability, "chat");
  assert.equal(commandPayload("hello").conversationId, undefined);
  assert.equal(commandPayload("hello", "server-id").conversationId, "server-id");
  assert.equal(commandPayload("hello").app, "ai-workspace");
  assert.equal(replyText({ ok: true, status: "unavailable", text: null }), null);
  assert.equal(replyText({ ok: true, status: "completed", text: "done" }), null);
  assert.equal(replyText({ ok: true, state: "done", status: "done", text: "done" }), "done");
  assert.equal(taskState(503, { ok: true, state: "done", text: "done" }).state, "failed");
  assert.equal(taskState(202, { taskId: "ab".repeat(16), state: "running" }).state, "pending");
  assert.equal(taskState(200, { ok: true, state: "running", taskId: "ab".repeat(16), text: null }).state, "pending");
  assert.equal(taskState(200, { ok: true, state: "done", text: "hello", taskId: "cd".repeat(16) }).state, "done");
  assert.equal(taskState(401, { ok: false }).state, "failed");
  assert.equal(stopState(200, { ok: true, state: "cancelled", taskId: "ab".repeat(16) }).state, "cancel_requested");
  assert.equal(taskIdOf({ taskId: "0" }), "");
  assert.equal(taskReadRequest({ AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", "ab".repeat(16)).url, "https://eliza-valhalla.onrender.com/api/v1/tasks/" + "ab".repeat(16));
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
