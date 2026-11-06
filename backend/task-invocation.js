import { createHash, randomBytes } from "node:crypto";

// Client role, budget, localPcAwake, transportHint, and allowCloud are preferences.
// This module overwrites them. A forged role does not change the session.
// Client callUsd is not a provider charge. Local work costs 0 and stays valid
// when the cloud budget is 0. A cloud estimate is a server cap and must be
// finite and greater than 0 before it is reserved. Provider invoices are separate.

export const APP_ALLOW = Object.freeze(["trading", "ai-workspace", "thalos", "data-explorer"]);
export const CAPABILITIES = Object.freeze(["voice", "reasoning", "paper", "view"]);
export const TOOLS = Object.freeze(["none", "paper-quote", "status"]);
export const TASK_TTL_MS = 15 * 60 * 1000;
export const CLOUD_ESTIMATE_USD = 0.01;

const APPS = new Set(APP_ALLOW);
const CAPS = new Set(CAPABILITIES);
const TOOL_SET = new Set(TOOLS);

export function createTaskCache() {
  return { byKey: new Map(), byId: new Map(), reserved: 0 };
}

export function serverPolicy(session, env = {}) {
  const remaining = Number(env.VALHALLA_BUDGET_USD || 0);
  const cloudKey = Boolean(env.DEEPSEEK_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
  const cloudModel = Boolean(env.DEEPSEEK_MODEL || env.GEMINI_MODEL);
  return {
    subject: session.userId,
    tenantId: session.userId,
    sessionRole: session.owner === true ? "owner" : "member",
    localRelay: String(env.VALHALLA_LOCAL_RELAY) === "1",
    allowCloud: cloudKey && cloudModel && remaining > 0,
    remainingUsd: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
    cloudEstimateUsd: CLOUD_ESTIMATE_USD,
  };
}

function bodyHash(body) {
  return createHash("sha256").update(JSON.stringify({
    text: String(body.text || "").slice(0, 8000),
    capability: body.capability || "",
    app: body.app || "",
    conversationId: String(body.conversationId || ""),
  })).digest("hex");
}

function bindingKey(session, app, hash) {
  return createHash("sha256").update([
    session.userId,
    session.userId,
    String(session.conversationId || ""),
    app,
    hash,
  ].join("\n")).digest("hex");
}

function freshId() {
  return randomBytes(16).toString("hex");
}

export function reserve(cache, amount) {
  if (!(amount > 0)) return { ok: true, reserved: 0 };
  if (cache.reserved + amount > cache.capUsd) return { ok: false, reserved: 0 };
  cache.reserved += amount;
  return { ok: true, reserved: amount };
}

export function release(cache, amount) {
  if (!(amount > 0)) return;
  cache.reserved = Math.max(0, cache.reserved - amount);
}

function publicRecord(record) {
  return {
    ok: record.ok,
    status: record.completed ? "completed" : "unavailable",
    taskId: record.taskId,
    parentTaskId: record.parentTaskId || null,
    sessionRole: record.sessionRole,
    capability: record.capability,
    app: record.app,
    text: record.text,
    chargeUsd: record.chargeUsd,
    chargeLabel: "server-usage-cap",
    replay: record.replay === true,
  };
}

export function admit(cache, session, body, policy, now = Date.now()) {
  cache.capUsd = policy.remainingUsd;
  if (!session || !session.userId) return { ok: false, status: 401, reason: "auth" };
  if (!CAPS.has(body.capability)) return { ok: false, status: 400, reason: "capability_rejected" };
  if (!APPS.has(body.app)) return { ok: false, status: 400, reason: "app_rejected" };
  if (body.tool != null && body.tool !== "" && !TOOL_SET.has(body.tool)) {
    return { ok: false, status: 400, reason: "tool_rejected" };
  }
  const hash = bodyHash(body);
  const key = bindingKey({ ...session, conversationId: body.conversationId }, body.app, hash);
  const prior = cache.byKey.get(key);
  if (prior && prior.exp >= now && !prior.stopped && prior.bodyHash === hash) {
    return { ok: true, status: 200, replay: true, response: publicRecord({ ...prior, replay: true }) };
  }
  if (body.taskId && cache.byId.has(body.taskId)) {
    const named = cache.byId.get(body.taskId);
    if (named.tenantId !== session.userId) return { ok: false, status: 403, reason: "tenant" };
    if (named.stopped) return { ok: false, status: 409, reason: "stopped" };
    if (named.bodyHash !== hash) return { ok: false, status: 409, reason: "hash_conflict" };
    return { ok: true, status: 200, replay: true, response: publicRecord({ ...named, replay: true }) };
  }
  let parentTaskId = null;
  if (body.parentTaskId) {
    const parent = cache.byId.get(body.parentTaskId);
    if (!parent || parent.tenantId !== session.userId) return { ok: false, status: 403, reason: "parent" };
    if (!parent.stopped) return { ok: false, status: 409, reason: "parent_open" };
    parentTaskId = parent.taskId;
  }
  const local = policy.localRelay === true;
  const chargeUsd = local ? 0 : policy.cloudEstimateUsd;
  if (!local && !policy.allowCloud) {
    return { ok: false, status: 503, reason: "unavailable", text: null, chargeUsd: 0 };
  }
  const held = reserve(cache, chargeUsd);
  if (!held.ok) return { ok: false, status: 503, reason: "budget", text: null, chargeUsd: 0 };
  const taskId = freshId();
  const record = {
    ok: true,
    taskId,
    parentTaskId,
    key,
    tenantId: session.userId,
    bodyHash: hash,
    sessionRole: policy.sessionRole,
    capability: body.capability,
    app: body.app,
    chargeUsd,
    text: null,
    completed: false,
    stopped: false,
    exp: now + TASK_TTL_MS,
    replay: false,
  };
  cache.byId.set(taskId, record);
  cache.byKey.set(key, record);
  return { ok: true, status: 200, replay: false, record, chargeUsd };
}

export function finish(cache, record, generated) {
  const text = generated && generated.completed ? String(generated.text || "") : null;
  record.completed = Boolean(text);
  record.ok = record.completed;
  record.text = text;
  record.reason = record.completed ? null : (generated && generated.reason) || "unavailable";
  if (!record.completed) release(cache, record.chargeUsd);
  return publicRecord(record);
}

export function stopTask(cache, session, taskId) {
  const record = cache.byId.get(taskId);
  if (!record || record.tenantId !== session.userId) return { ok: false, status: 404, reason: "missing" };
  record.stopped = true;
  return { ok: true, status: 200, taskId };
}
