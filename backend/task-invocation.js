import { createHash, randomBytes } from "node:crypto";
import { createBudgetLedger } from "./budget.js";
import { classifyAction, executionDecision } from "./constitution.js";

// Client role, budget, localPcAwake, transportHint, and allowCloud are preferences.
// This module overwrites them. A forged role does not change the session.
// Client callUsd is not a provider charge. Local work costs 0 and stays valid
// when the cloud budget is 0. A cloud estimate is a server cap and must be
// finite and greater than 0 before it is reserved. Provider invoices are separate.

export const APP_ALLOW = Object.freeze(["trading", "ai-workspace", "thalos", "data-explorer"]);
export const CAPABILITIES = Object.freeze(["voice", "reasoning", "paper", "view", "chat"]);
export const TOOLS = Object.freeze(["none", "paper-quote", "status"]);
export const TASK_TTL_MS = 15 * 60 * 1000;
export const CLOUD_ESTIMATE_USD = 0.01;

const APPS = new Set(APP_ALLOW);
const CAPS = new Set(CAPABILITIES);
const TOOL_SET = new Set(TOOLS);

export function createTaskCache() {
  return { byKey: new Map(), byId: new Map(), tenants: new Map(), conversations: {}, budget: createBudgetLedger() };
}

export function serverPolicy(session, env = {}) {
  const remaining = Number(env.VALHALLA_BUDGET_USD || 0);
  const decision = executionDecision(session, env);
  const cloudKey = Boolean(env.DEEPSEEK_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
  const cloudModel = Boolean(env.DEEPSEEK_MODEL || env.GEMINI_MODEL);
  return {
    subject: session.userId,
    tenantId: session.userId,
    sessionRole: session.owner === true ? "owner" : "member",
    localRelay: decision.environment === "local",
    allowCloud: decision.environment === "cloud",
    available: decision.available === true,
    environment: decision.environment,
    fallback: decision.fallback === true,
    policyId: decision.policyId || "nominal",
    spendCeilingUsd: decision.spendCeilingUsd || 0,
    liveTrading: false,
    ownerEmail: null,
    distributed: false,
    atomic: false,
    remainingUsd: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
    cloudEstimateUsd: CLOUD_ESTIMATE_USD,
    production: env.NODE_ENV === "production",
    durable: env.VALHALLA_STORE_DURABLE === "1",
    models: [
      decision.environment === "local" ? (env.OLLAMA_MODEL || "qwen2.5-coder:14b") : "",
      cloudKey && cloudModel ? (env.DEEPSEEK_MODEL || "") : "",
      cloudKey && cloudModel ? (env.GEMINI_MODEL || "") : "",
    ].filter(Boolean),
  };
}

const KNOWN_FIELDS = new Set([
  "capability", "app", "text", "source", "conversationId", "provider", "model",
  "tool", "query", "taskId", "parentTaskId", "role", "callUsd", "allowCloud", "localPcAwake",
  "effect", "environment", "idempotencyKey",
]);
const QUERY_FIELDS = new Set(["inputMint", "outputMint", "amount"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function toolQuery(body) {
  if (body.tool !== "paper-quote") return {};
  const query = body.query && typeof body.query === "object" ? body.query : {};
  return {
    inputMint: String(query.inputMint || ""),
    outputMint: String(query.outputMint || ""),
    amount: String(query.amount || ""),
  };
}

function scopeIds(session) {
  return {
    tenantId: String(session.tenantId || session.userId || ""),
    subject: String(session.subject || session.userId || ""),
  };
}

function bodyHash(session, body) {
  const scope = scopeIds(session);
  return createHash("sha256").update(JSON.stringify(canonical({
    tenantId: scope.tenantId,
    subject: scope.subject,
    app: body.app || "",
    conversationId: String(body.conversationId || ""),
    capability: body.capability || "",
    model: body.model || "",
    provider: body.provider || "",
    tool: body.tool || "none",
    query: toolQuery(body),
    text: String(body.text || ""),
    source: String(body.source || ""),
  }))).digest("hex");
}

function bindingKey(session, app, hash) {
  const scope = scopeIds(session);
  return createHash("sha256").update([
    scope.tenantId,
    scope.subject,
    String(session.conversationId || ""),
    app,
    hash,
  ].join("\n")).digest("hex");
}

function freshId() {
  return randomBytes(16).toString("hex");
}

export function reserve(cache, tenantId, amount, capUsd) {
  if (!cache.budget) cache.budget = createBudgetLedger();
  const result = cache.budget.select({
    tenantId,
    jobId: randomBytes(8).toString("hex"),
    amount: amount > 0 ? amount : 0,
    capUsd,
  });
  return { ok: result.ok === true, reserved: result.ok ? result.reserved : 0, atomic: false, distributed: false };
}

function settleSpend(cache, record, actualUsd) {
  if (!cache || !cache.budget || !record || !record.jobId || record.settled === true) return;
  const settled = cache.budget.settle(record.jobId, actualUsd);
  if (!settled.ok) return;
  record.settled = true;
  record.spentUsd = settled.spentUsd;
  record.billing = {
    localCpuUsd: 0,
    cloudHoldUsd: 0,
    cloudCostUsd: record.environment === "cloud" ? settled.spentUsd : 0,
    disclosed: true,
    invoice: false,
  };
}

function publicRecord(record) {
  return {
    ok: record.ok,
    state: record.state,
    status: record.state,
    taskId: record.taskId,
    parentTaskId: record.parentTaskId || null,
    sessionRole: record.sessionRole,
    capability: record.capability,
    app: record.app,
    text: record.text,
    chargeUsd: record.chargeUsd,
    chargeLabel: "server-usage-cap",
    effect: record.effect || null,
    environment: record.environment || null,
    fallback: record.fallback === true,
    liveTrading: false,
    billing: record.billing || null,
    replay: record.replay === true,
    reason: record.reason || null,
    trace: record.trace || null,
    sync: true,
  };
}

function unknownField(body) {
  for (const key of Object.keys(body || {})) {
    if (!KNOWN_FIELDS.has(key)) return key;
  }
  if (body.query && typeof body.query === "object") {
    for (const key of Object.keys(body.query)) {
      if (!QUERY_FIELDS.has(key)) return key;
    }
  }
  return "";
}

export function admit(cache, session, body, policy, membership = { installed: [], role: "member" }, now = Date.now()) {
  if (policy && policy.production === true && policy.durable !== true) {
    return { ok: false, status: 503, reason: "durable_store_required" };
  }
  if (!session || !session.userId) return { ok: false, status: 401, reason: "auth" };
  if (Buffer.byteLength(String(body.text || "")) > 8000) return { ok: false, status: 400, reason: "text_too_long" };
  let conversationId = body.conversationId;
  if (conversationId == null) conversationId = randomBytes(16).toString("hex");
  else conversationId = String(conversationId);
  if (conversationId === "" || conversationId === "0" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(conversationId) || conversationId === session.userId) {
    return { ok: false, status: 400, reason: "conversation_required" };
  }
  const request = { ...body, conversationId };
  if (body.model && !(policy.models || []).includes(body.model)) request.model = "";
  const idem = body.idempotencyKey == null || body.idempotencyKey === "" ? "" : String(body.idempotencyKey);
  if (body.idempotencyKey != null && body.idempotencyKey !== "" && !/^[A-Za-z0-9_-]{8,80}$/.test(idem)) {
    return { ok: false, status: 400, reason: "idempotency_key" };
  }
  const extra = unknownField(body);
  if (extra) return { ok: false, status: 400, reason: "unknown_field" };
  const roleNow = membership.role === "owner" ? "owner" : "member";
  if (!CAPS.has(body.capability)) return { ok: false, status: 400, reason: "capability_rejected" };
  if (!APPS.has(body.app)) return { ok: false, status: 400, reason: "app_rejected" };
  if (!Array.isArray(membership.installed) || !membership.installed.includes(body.app)) {
    return { ok: false, status: 403, reason: "effective_entitlement" };
  }
  if (body.tool === "paper-quote" && roleNow !== "owner") {
    return { ok: false, status: 403, reason: "role" };
  }
  if (body.tool != null && body.tool !== "" && !TOOL_SET.has(body.tool)) {
    return { ok: false, status: 400, reason: "tool_rejected" };
  }
  if (!cache.conversations) cache.conversations = {};
  if (conversationId) {
    const bound = cache.conversations[conversationId];
    if (bound && bound.tenantId !== scopeIds(session).tenantId && bound.tenantId !== session.userId) {
      return { ok: false, status: 403, reason: "tenant" };
    }
  }
  const hash = bodyHash(session, request);
  const key = bindingKey({ ...session, conversationId }, request.app, hash);
  if (!cache.byIdem) cache.byIdem = new Map();
  const prior = idem ? cache.byIdem.get(`${session.userId}\n${idem}`) : null;
  if (prior && prior.tenantId === session.userId) {
    if (prior.bodyHash !== hash) return { ok: false, status: 409, reason: "hash_conflict", taskId: prior.taskId };
    if (prior.stopped || prior.state === "cancelled") {
      return { ok: false, status: 409, reason: "stopped", taskId: prior.taskId, response: publicRecord(prior) };
    }
    const running = prior.state === "running" || prior.state === "cancel_requested";
    return { ok: true, status: running ? 202 : 200, replay: true, response: publicRecord({ ...prior, replay: true }) };
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
  const classified = classifyAction(body);
  if (!classified.ok || classified.execute === true) {
    return { ok: false, status: 400, reason: classified.reason || "effect_rejected" };
  }
  if (policy.liveTrading === true) return { ok: false, status: 403, reason: "live_trading_disabled" };
  const local = Object.prototype.hasOwnProperty.call(policy, "environment")
    ? policy.environment === "local"
    : policy.localRelay === true;
  const available = Object.prototype.hasOwnProperty.call(policy, "available")
    ? policy.available === true
    : (local || policy.allowCloud === true);
  const chargeUsd = local ? 0 : policy.cloudEstimateUsd;
  if (!available) {
    return { ok: false, status: 503, reason: "unavailable", text: null, chargeUsd: 0, fallback: false };
  }
  if (!cache.budget) cache.budget = createBudgetLedger();
  const held = cache.budget.select({
    tenantId: session.userId,
    jobId: key,
    amount: chargeUsd,
    capUsd: local ? 0 : policy.remainingUsd,
  });
  if (!held.ok) {
    return {
      ok: false,
      status: 503,
      reason: "quota",
      text: null,
      chargeUsd: 0,
      error: { code: "quota", timeoutMs: 8000, guaranteed: false },
    };
  }
  const taskId = freshId();
  const record = {
    ok: true,
    taskId,
    parentTaskId,
    key,
    tenantId: session.userId,
    bodyHash: hash,
    sessionRole: roleNow,
    capability: body.capability,
    app: body.app,
    tool: body.tool || "none",
    provider: body.provider || "",
    chargeUsd,
    jobId: key,
    effect: classified.effect,
    environment: local ? "local" : "cloud",
    fallback: local ? false : policy.fallback === true,
    liveTrading: false,
    billing: {
      localCpuUsd: 0,
      cloudHoldUsd: local ? 0 : chargeUsd,
      cloudCostUsd: 0,
      disclosed: true,
      invoice: false,
    },
    text: null,
    completed: false,
    stopped: false,
    state: "running",
    reason: null,
    trace: null,
    version: 1,
    cancelRequested: false,
    idempotencyKey: idem || null,
    conversationId,
    model: request.model || "",
    exp: now + TASK_TTL_MS,
    replay: false,
  };
  cache.byId.set(taskId, record);
  cache.byKey.set(key, record);
  if (idem) cache.byIdem.set(`${session.userId}\n${idem}`, record);
  if (conversationId) {
    const bound = cache.conversations[conversationId] || { tenantId: session.userId, taskIds: [] };
    bound.taskIds.push(taskId);
    cache.conversations[conversationId] = bound;
  }
  return { ok: true, status: 200, replay: false, record, chargeUsd };
}

export function finish(cache, record, generated) {
  const quoteOk = record.tool !== "paper-quote" || generated?.toolAuthorized === true;
  const text = quoteOk && generated && generated.completed ? String(generated.text || "") : null;
  if (record.cancelRequested) {
    record.stopped = true;
    record.state = "cancelled";
    record.completed = false;
    record.ok = false;
    record.text = null;
    record.reason = "cancelled";
    record.version = (record.version || 1) + 1;
    settleSpend(cache, record, 0);
  } else if (record.stopped) {
    record.state = "cancelled";
    record.completed = false;
    record.ok = false;
    record.text = null;
    record.reason = "cancelled";
    settleSpend(cache, record, 0);
  } else if (text) {
    record.state = "done";
    record.completed = true;
    record.ok = true;
    record.text = text;
    record.reason = null;
  } else {
    record.state = "failed";
    record.completed = false;
    record.ok = false;
    record.text = null;
    record.reason = record.tool === "paper-quote" && !quoteOk
      ? "tool_unauthorized"
      : (generated && generated.reason) || "unavailable";
    settleSpend(cache, record, 0);
  }
  if (text && record.environment === "cloud") {
    const actual = Number(generated && generated.actualUsd);
    settleSpend(cache, record, Number.isFinite(actual) ? actual : 0);
  }
  if (text && record.environment !== "cloud") settleSpend(cache, record, 0);
  if (generated && (generated.provider || generated.model)) {
    record.trace = {
      route: generated.provider || null,
      provider: generated.provider || null,
      model: generated.model || null,
    };
  }
  return publicRecord(record);
}

export function stopTask(cache, session, taskId) {
  const record = cache.byId.get(taskId);
  if (!record || record.tenantId !== session.userId) return { ok: false, status: 404, reason: "missing" };
  if (record.state === "done") {
    return { ok: true, status: 200, taskId, reason: "done", state: "done" };
  }
  if (record.state === "cancelled" || record.stopped) {
    return { ok: true, status: 200, taskId, reason: "cancelled", state: "cancelled" };
  }
  record.cancelRequested = true;
  record.state = "cancel_requested";
  record.reason = "cancel_requested";
  record.version = (record.version || 1) + 1;
  return { ok: true, status: 202, taskId, reason: "cancel_requested", state: "cancel_requested" };
}

export function readTask(cache, session, taskId) {
  if (!/^[0-9a-f]{32}$/.test(String(taskId || ""))) return { ok: false, status: 404, reason: "missing" };
  const record = cache.byId.get(taskId);
  if (!record || record.tenantId !== session.userId) return { ok: false, status: 404, reason: "missing" };
  return { ok: true, status: 200, task: publicRecord(record) };
}

export function history(cache, session, conversationId) {
  const bound = cache.conversations && cache.conversations[conversationId];
  if (!bound || bound.tenantId !== session.userId) return { ok: false, status: 403, reason: "tenant" };
  return {
    ok: true,
    status: 200,
    tasks: bound.taskIds.map((id) => cache.byId.get(id)).filter(Boolean).map(publicRecord),
  };
}

export function saveTasks(store, cache) {
  store.data.tasks = {};
  for (const record of cache.byId.values()) store.data.tasks[record.taskId] = record;
  store.data.conversations = cache.conversations || {};
  store.flush();
}

export function loadTasks(store) {
  const cache = createTaskCache();
  cache.conversations = store.data.conversations || {};
  for (const record of Object.values(store.data.tasks || {})) {
    if (record.state === "running" || record.state === "cancel_requested") {
      record.state = "provider_interrupted";
      record.text = null;
      record.completed = false;
      record.reason = "provider_interrupted";
    }
    cache.byId.set(record.taskId, record);
    if (record.key) cache.byKey.set(record.key, record);
  }
  return cache;
}
