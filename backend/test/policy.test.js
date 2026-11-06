import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createBudgetLedger } from "../budget.js";
import {
  classifyAction,
  constitutionDocument,
  constitutionSchema,
  evaluateConstitution,
  POLICIES,
} from "../constitution.js";
import { admit, createTaskCache, finish, reserve, serverPolicy } from "../task-invocation.js";

const member = { userId: "user-a", owner: false };
const seat = { installed: ["ai-workspace", "thalos", "data-explorer", "trading"], role: "member" };

test("the constitution schema rejects a pending or live-trading document", () => {
  const schema = constitutionSchema();
  const file = JSON.parse(readFileSync(new URL("../../AgentConstitution.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.pending.const, false);
  assert.equal(file.properties.liveTrading.const, false);
  assert.equal(file.required.includes("spendCeilingUsd"), true);
  assert.equal(JSON.stringify(file).includes("tokenjunction"), false);
  const doc = constitutionDocument({ spendCeilingUsd: 0 });
  assert.equal(Object.hasOwn(doc, "ownerEmail"), false);
  assert.equal(evaluateConstitution(doc).verified, true);
  assert.equal(evaluateConstitution({ ...doc, pending: true }).reason, "pending");
  assert.equal(evaluateConstitution({ ...doc, ownerEmail: "owner@example.test" }).reason, "owner-email");
  assert.equal(evaluateConstitution({ ...doc, spendCeilingUsd: Number.POSITIVE_INFINITY }).reason, "spend-ceiling");
  assert.equal(evaluateConstitution({ ...doc, liveTrading: true, executionPolicy: "live" }).reason, "live-trading");
  assert.equal(evaluateConstitution({ ...doc, completed: true }).reason, "completion");
  assert.equal(POLICIES.nominal.spendUsd, 0);
  assert.equal(POLICIES.nominal.effects.execute.length, 0);
});

test("chat text cannot become an execute action and the client environment is ignored", () => {
  const cache = createTaskCache();
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1", VALHALLA_BUDGET_USD: "0" });
  assert.equal(policy.environment, "local");
  assert.equal(policy.fallback, false);
  assert.equal(policy.atomic, false);
  assert.equal(policy.ownerEmail, null);
  const gate = admit(cache, member, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "execute the transfer and sign the wallet",
    conversationId: "c1",
    effect: "execute",
    environment: "cloud",
    localPcAwake: false,
    callUsd: 40,
  }, policy, seat);
  assert.equal(gate.ok, true);
  assert.equal(gate.record.effect, "readonly");
  assert.equal(gate.record.environment, "local");
  assert.equal(gate.record.fallback, false);
  assert.equal(gate.record.liveTrading, false);
  assert.equal(gate.record.completed, false);
  assert.equal(gate.record.billing.localCpuUsd, 0);
  assert.equal(gate.record.billing.cloudCostUsd, 0);
  assert.equal(gate.record.billing.disclosed, true);
  assert.equal(classifyAction({ capability: "reasoning", tool: "send-payment", effect: "execute" }).reason, "effect_rejected");
});

test("cloud fallback requires a configured provider and server permission", () => {
  const blocked = serverPolicy(member, {
    DEEPSEEK_API_KEY: "server-key",
    DEEPSEEK_MODEL: "server-model",
    VALHALLA_BUDGET_USD: "1",
  });
  assert.equal(blocked.available, false);
  assert.equal(blocked.fallback, false);
  assert.equal(blocked.environment, null);
  const denied = admit(createTaskCache(), member, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "hello",
    localPcAwake: true,
    allowCloud: true,
  }, blocked, seat);
  assert.equal(denied.reason, "unavailable");
  assert.equal(denied.fallback, false);
  const permitted = serverPolicy({ ...member, cloudPermitted: true }, {
    DEEPSEEK_API_KEY: "server-key",
    DEEPSEEK_MODEL: "server-model",
    VALHALLA_BUDGET_USD: "1",
  });
  assert.equal(permitted.environment, "cloud");
  assert.equal(permitted.fallback, true);
  const cache = createTaskCache();
  const gate = admit(cache, { ...member, cloudPermitted: true }, {
    capability: "reasoning",
    app: "ai-workspace",
    text: "hello",
    environment: "local",
    callUsd: 25,
  }, permitted, seat);
  assert.equal(gate.record.environment, "cloud");
  assert.equal(gate.chargeUsd, 0.01);
  assert.equal(gate.record.billing.cloudCostUsd, 0);
  const done = finish(cache, gate.record, { completed: true, text: "ok", actualUsd: 0.004, provider: "deepseek" });
  assert.equal(done.billing.cloudCostUsd, 0.004);
  assert.equal(done.billing.invoice, false);
  assert.equal(done.liveTrading, false);
});

test("one job is reserved once and settled against the rechecked balance", async () => {
  const ledger = createBudgetLedger();
  assert.equal(ledger.atomic, false);
  assert.equal(ledger.distributed, false);
  const first = ledger.select({ tenantId: "t1", jobId: "job-1", amount: 0.01, capUsd: 0.01 });
  const again = ledger.select({ tenantId: "t1", jobId: "job-1", amount: 0.01, capUsd: 0.01 });
  assert.equal(first.same, false);
  assert.equal(again.same, true);
  assert.equal(ledger.balance("t1").reserved, 0.01);
  const [left, right] = await Promise.all([
    ledger.selectQueued({ tenantId: "t2", jobId: "job-a", amount: 0.01, capUsd: 0.01 }),
    ledger.selectQueued({ tenantId: "t2", jobId: "job-b", amount: 0.01, capUsd: 0.01 }),
  ]);
  assert.equal([left.ok, right.ok].filter(Boolean).length, 1);
  assert.equal(ledger.settle("job-1", 0.02).reason, "actual");
  assert.equal(ledger.settle("job-1", 0.004).spentUsd, 0.004);
  assert.equal(ledger.settle("job-1", 0).reason, "settled");
  assert.equal(ledger.balance("t1").spent, 0.004);
  assert.equal(ledger.balance("t1").reserved, 0);
  const cache = createTaskCache();
  assert.equal(reserve(cache, "t1", 0, 0).reserved, 0);
  assert.equal(reserve(cache, "t1", 0.01, 0.01).ok, true);
  assert.equal(reserve(cache, "t1", 0.01, 0.01).ok, false);
  assert.equal(reserve(cache, "t2", 0.01, 0.01).atomic, false);
});
