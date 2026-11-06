import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Personal plan metadata. This store does not charge a card and it is not deployed.
// Capacity stays 0 until the operator marks the deployment ready.

export const PERSONAL_PLAN = Object.freeze({
  id: "valhallaos-personal",
  priceUsd: 5,
  interval: "month",
  charge: false,
});
export const PAPER_SIM_CAP = 100;
export const PREVIEW_CAP = 10;
export const CAPACITY_BOUND = 100;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createPlanStore() {
  let chain = Promise.resolve();
  const state = {
    cap: null,
    active: new Map(),
    invites: new Map(),
    paper: new Map(),
    events: new Map(),
    distributed: false,
    atomic: false,
  };
  function run(fn) {
    const job = chain.then(() => fn());
    chain = job.then(() => undefined, () => undefined);
    return job;
  }
  return {
    distributed: false,
    atomic: false,
    run,
    state,
  };
}

export function viewCapacity(store, env = {}) {
  const ready = env.PUBLIC_CAPACITY_READY === "true";
  const set = store.state.cap;
  let cap = 0;
  if (ready) cap = Number.isInteger(set) ? set : PREVIEW_CAP;
  return {
    plan: PERSONAL_PLAN.id,
    priceUsd: PERSONAL_PLAN.priceUsd,
    interval: PERSONAL_PLAN.interval,
    charge: false,
    publicCapacityReady: ready,
    activeCap: cap,
    active: store.state.active.size,
    maxConcurrentLocalTasks: 1,
    previewCap: PREVIEW_CAP,
  };
}

export function setCapacity(store, actor, cap) {
  if (!actor || actor.owner !== true) return { ok: false, reason: "owner" };
  if (!Number.isInteger(cap) || cap < 0 || cap > CAPACITY_BOUND) return { ok: false, reason: "bounds" };
  store.state.cap = cap;
  return { ok: true, cap, charge: false };
}

export function issueInvite(store, now = Date.now()) {
  const code = randomBytes(16).toString("hex");
  store.state.invites.set(code, { status: "pending", exp: now + INVITE_TTL_MS, used: false });
  return { ok: true, code, status: "pending", exp: now + INVITE_TTL_MS };
}

export async function activateInvite(store, input, now = Date.now()) {
  return store.run(() => {
    const invite = store.state.invites.get(input.code);
    const identity = String(input.identity || "");
    if (!/^[0-9a-f]{64}$/.test(identity)) return { ok: false, reason: "identity", license: null };
    if (!invite || invite.used || invite.exp < now) return { ok: false, reason: "invite", license: null };
    const usable = input.usable || {};
    if (usable.workspace !== true || usable.task !== true || usable.signin !== true) {
      return { ok: false, reason: "not-usable", license: null };
    }
    const view = viewCapacity(store, input.env || {});
    const existing = store.state.active.get(identity);
    const customers = [...store.state.active.values()].filter((row) => row.ownerBypass !== true).length;
    if (!existing && input.owner !== true && customers >= view.activeCap) {
      return { ok: false, reason: "capacity", status: "pending", license: null };
    }
    invite.used = true;
    invite.status = "used";
    if (!existing) {
      store.state.active.set(identity, {
        plan: PERSONAL_PLAN.id,
        at: now,
        license: true,
        ownerBypass: input.owner === true,
      });
    }
    return {
      ok: true,
      license: true,
      plan: PERSONAL_PLAN.id,
      priceUsd: PERSONAL_PLAN.priceUsd,
      charge: false,
      sameIdentity: Boolean(existing),
    };
  });
}

export function recordPaperSim(store, identity) {
  if (!/^[0-9a-f]{64}$/.test(String(identity || ""))) return { ok: false, reason: "identity" };
  const count = store.state.paper.get(identity) || 0;
  if (count >= PAPER_SIM_CAP) return { ok: false, reason: "sim-cap", count, advice: false, live: false };
  store.state.paper.set(identity, count + 1);
  return { ok: true, count: count + 1, advice: false, live: false, reset: false };
}

export function stripeAdapter(env = {}) {
  return {
    enabled: false,
    checkout: false,
    charge: false,
    priceUsd: PERSONAL_PLAN.priceUsd,
    interval: PERSONAL_PLAN.interval,
    secretConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
  };
}

export function acceptStripeEvent(store, env, raw, header) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "disabled", applied: false, charge: false };
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const left = Buffer.from(String(header || ""));
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: "signature", applied: false, charge: false };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "body", applied: false, charge: false };
  }
  if (!body.id) return { ok: false, reason: "event", applied: false, charge: false };
  if (store.state.events.has(body.id)) return { ok: true, duplicate: true, applied: false, charge: false };
  store.state.events.set(body.id, { at: Date.now(), applied: false });
  return { ok: true, duplicate: false, applied: false, charge: false, role: null };
}

export function cancelPlan(store, identity, now = Date.now()) {
  const row = store.state.active.get(identity);
  if (!row) return { ok: false, reason: "missing", deleted: false };
  row.cancelledAt = now;
  row.deleteAfter = now + RETENTION_MS;
  return {
    ok: true,
    deleted: false,
    historyKept: true,
    exportRequired: true,
    retentionDays: 30,
    deleteAfter: row.deleteAfter,
  };
}
