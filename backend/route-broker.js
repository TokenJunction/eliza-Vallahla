// The server picks local first. The browser does not choose the fallback.
// No tunnel is installed here. ngrok stays off unless the operator configures it
// and the account asks to activate it.

export const WATCHDOG_MS = 30 * 1000;
export const RATE_PER_MINUTE = 6;
const MODEL = "qwen2.5-coder:14b";

export function createRouteBroker() {
  return { locals: new Map(), inflight: new Map(), tasks: new Map(), rates: new Map() };
}

export function tunnelChoice(env = {}, requested = "socket") {
  if (requested === "ngrok") {
    const configured = Boolean(env.NGROK_AUTHTOKEN) && env.NGROK_ENABLED === "1";
    return {
      provider: configured ? "ngrok" : "socket",
      active: false,
      autoInstall: false,
      reason: configured ? "manual-activation-only" : "ngrok-not-configured",
    };
  }
  return { provider: "socket", active: false, listener: "not-attached", autoInstall: false };
}

export function registerLocal(broker, account, input, now = Date.now()) {
  if (!account || !account.tenantId || !account.subjectId) return { ok: false, reason: "auth" };
  if (input.model !== MODEL) return { ok: false, reason: "model" };
  if (input.url || input.command) return { ok: false, reason: "pipeline" };
  const key = `${account.tenantId}:${account.subjectId}`;
  broker.locals.set(key, { model: MODEL, ready: input.ready === true, at: now, device: String(input.device || "") });
  return { ok: true, model: MODEL, ready: input.ready === true };
}

function rateOk(broker, tenantId, now) {
  const row = broker.rates.get(tenantId) || { start: now, count: 0 };
  if (now - row.start >= 60 * 1000) {
    row.start = now;
    row.count = 0;
  }
  if (row.count >= RATE_PER_MINUTE) {
    broker.rates.set(tenantId, row);
    return false;
  }
  row.count += 1;
  broker.rates.set(tenantId, row);
  return true;
}

export function openRoute(broker, account, env, now = Date.now()) {
  if (!account || !account.tenantId || !account.subjectId) return { ok: false, reason: "auth", text: null };
  const key = `${account.tenantId}:${account.subjectId}`;
  if (broker.inflight.has(key)) {
    const current = broker.tasks.get(broker.inflight.get(key));
    return { ok: false, reason: "inflight", taskId: current.taskId, progress: current.progress, text: null };
  }
  if (!rateOk(broker, account.tenantId, now)) return { ok: false, reason: "rate", text: null };
  const local = broker.locals.get(key);
  const cloud = account.cloudPermitted === true && Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL);
  let progress = "Waiting for local PC";
  let environment = null;
  if (local && local.ready && now - local.at <= WATCHDOG_MS) {
    progress = "Processing locally";
    environment = "local";
  } else if (local && now - local.at > WATCHDOG_MS) {
    progress = cloud ? "Processing on cloud" : "Local unavailable; cloud not enabled";
    environment = cloud ? "cloud" : null;
  }
  const taskId = `${key}:${now}`;
  const task = {
    taskId,
    owner: key,
    progress,
    environment,
    text: null,
    completed: false,
    chargeUsd: 0,
    localCpuUsd: 0,
    freeCloudPool: false,
    cancelled: false,
  };
  broker.tasks.set(taskId, task);
  broker.inflight.set(key, taskId);
  return { ok: progress !== "Local unavailable; cloud not enabled", ...task };
}

export function cancelRoute(broker, account, taskId) {
  const task = broker.tasks.get(taskId);
  if (!task || !account) return { ok: false, reason: "missing", text: null };
  const key = `${account.tenantId}:${account.subjectId}`;
  if (task.owner !== key) return { ok: false, reason: "tenant", text: null };
  task.cancelled = true;
  task.progress = "cancelled";
  task.completed = false;
  task.text = null;
  if (broker.inflight.get(key) === taskId) broker.inflight.delete(key);
  return { ok: true, taskId, progress: "cancelled", text: null };
}
