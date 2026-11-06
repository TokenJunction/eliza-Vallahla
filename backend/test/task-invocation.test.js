import assert from "node:assert/strict";
import test from "node:test";
import { admit, createTaskCache, reserve, serverPolicy, stopTask } from "../task-invocation.js";

const member = { userId: "user-a", owner: false };

test("a forged role and client budget do not change the server decision", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1", VALHALLA_BUDGET_USD: "0" });
  const gate = admit(cache, member, {
    role: "owner",
    capability: "reasoning",
    app: "ai-workspace",
    text: "hello",
    conversationId: "c1",
    callUsd: 50,
    allowCloud: true,
    localPcAwake: true,
  }, policy);
  assert.equal(gate.ok, true);
  assert.equal(gate.record.sessionRole, "member");
  assert.equal(gate.chargeUsd, 0);
});

test("local work stays valid when the cloud budget is zero", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1" });
  assert.equal(policy.remainingUsd, 0);
  const gate = admit(cache, member, {
    capability: "paper",
    app: "thalos",
    text: "view",
    conversationId: "c1",
  }, policy);
  assert.equal(gate.ok, true);
  assert.equal(gate.chargeUsd, 0);
});

test("cloud without a server key is unavailable and does not reserve", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, {});
  const gate = admit(cache, member, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "hello",
    conversationId: "c1",
    callUsd: 1,
  }, policy);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "unavailable");
  assert.equal(cache.reserved, 0);
});

test("the same binding replays and a different body conflicts", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1" });
  const first = admit(cache, member, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "one",
    conversationId: "c1",
  }, policy);
  const again = admit(cache, member, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "one",
    conversationId: "c1",
  }, policy);
  assert.equal(again.replay, true);
  assert.equal(again.response.taskId, first.record.taskId);
  const clash = admit(cache, member, {
    taskId: first.record.taskId,
    capability: "reasoning",
    app: "ai-workspace",
    text: "two",
    conversationId: "c1",
  }, policy);
  assert.equal(clash.reason, "hash_conflict");
});

test("a stopped task stays stopped until a new parent id is explicit", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1" });
  const first = admit(cache, member, {
    capability: "view",
    app: "data-explorer",
    text: "rows",
    conversationId: "c1",
  }, policy);
  assert.equal(stopTask(cache, member, first.record.taskId).ok, true);
  const resume = admit(cache, member, {
    taskId: first.record.taskId,
    capability: "view",
    app: "data-explorer",
    text: "rows",
    conversationId: "c1",
  }, policy);
  assert.equal(resume.reason, "stopped");
  const next = admit(cache, member, {
    parentTaskId: first.record.taskId,
    capability: "view",
    app: "data-explorer",
    text: "rows again",
    conversationId: "c2",
  }, policy);
  assert.equal(next.ok, true);
  assert.notEqual(next.record.taskId, first.record.taskId);
  assert.equal(next.record.parentTaskId, first.record.taskId);
});

test("two cloud reservations cannot both spend the same cap", () => {
  const cache = createTaskCache();
  cache.capUsd = 0.01;
  assert.equal(reserve(cache, 0).ok, true);
  assert.equal(reserve(cache, 0.01).ok, true);
  assert.equal(reserve(cache, 0.01).ok, false);
});

test("unknown tools and apps are rejected", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1" });
  assert.equal(admit(cache, member, { capability: "shell", app: "ai-workspace", text: "x" }, policy).reason, "capability_rejected");
  assert.equal(admit(cache, member, { capability: "reasoning", app: "other", text: "x" }, policy).reason, "app_rejected");
  assert.equal(admit(cache, member, { capability: "reasoning", app: "ai-workspace", text: "x", tool: "() => exec()" }, policy).reason, "tool_rejected");
});
