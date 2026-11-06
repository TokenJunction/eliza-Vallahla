import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bindInvocation, canonical, fail, scopeKey, sha } from './canonical.mjs';

const copy = x => structuredClone(x);
export const units = n => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 9_000_000_000_000) fail('invalid_units');
  return n;
};
const terminal = s => ['completed', 'failed', 'stopped'].includes(s);
const reply = (record, replay = true) => ({
  ok: true, status: terminal(record.status) ? 200 : 202, replay,
  response: copy(record.response || { taskId: record.taskId, parentTaskId: record.parentTaskId,
    status: record.status, text: null }),
});
const checkToken = (r, token) => {
  if (typeof token !== 'string' || !r.tokenHash || !timingSafeEqual(Buffer.from(sha(token)), Buffer.from(r.tokenHash))) fail('fence', 409);
};
const token = () => randomBytes(32).toString('hex');
const safeMetadata = usage => {
  if (usage == null) return null;
  const out = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) if (usage[key] != null) out[key] = units(usage[key]);
  return out; // only actual adapter-returned token counts, no rate inference or arbitrary metadata.
};

// All transitions below are synchronous, with no await inside the read/check/write critical section.
// Dev only: no process-shared guarantees. Exposes no internal record or fence token on replay.
export function createMemoryStore({ environment = 'development', maxTasks = 1000, maxDepth = 2, authResolver } = {}) {
  if (!['development', 'test'].includes(environment)) fail('durable_store_required', 503);
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) fail('invalid_limits');
  if (typeof authResolver !== 'function') fail('auth_resolver_required', 503);
  const live = scope => {
    let a; try { a = authResolver(scope); } catch { return false; }
    return a && typeof a.then !== 'function' && a.verified === true && a.tenantId === scope.tenantId &&
      a.subject === scope.subject && a.authRef === scope.authRef && a.authVersion === scope.authVersion && a.sessionRole === scope.sessionRole && Number.isFinite(a.expiresAt) && a.expiresAt > Date.now();
  };
  const auth = scope => { if (!live(scope)) fail('auth', 401); };
  const scopes = new Map();
  const get = scope => scopes.get(scopeKey(scope)) || fail('ledger_unavailable', 503);
  function provision(scope, limitUnits) {
    units(limitUnits);
    const k = scopeKey(scope);
    if (scopes.has(k)) return snapshot(scope); // cannot reset spent/reservations on hot path
    scopes.set(k, { limitUnits, reserved: 0, spent: 0, tasks: new Map(), bindings: new Map(), stoppedScopes: new Set() });
    return snapshot(scope);
  }
  function snapshot(scope) {
    const s = get(scope); return { limitUnits: s.limitUnits, reserved: s.reserved, spent: s.spent, count: s.tasks.size };
  }
  function settle(s, r, settlement) {
    const { outcome, actualUnits = 0, usage = null } = settlement;
    if (!['committed', 'not_committed', 'unknown'].includes(outcome)) fail('invalid_outcome');
    units(actualUnits);
    if (actualUnits > r.reserveUnits || (outcome !== 'committed' && actualUnits !== 0)) fail('invalid_charge');
    const metadata = safeMetadata(usage);
    const digest = sha(canonical({ outcome, actualUnits, usage: metadata }));
    if (r.settlementHash) {
      if (r.settlementHash !== digest) fail('settlement_conflict', 409);
      return; // exact same settlement is once only
    }
    if (outcome === 'unknown') { r.providerState = 'unknown'; return; }
    if (outcome === 'committed' && !r.started) fail('not_started', 409);
    s.reserved -= r.reserveUnits;
    s.spent += actualUnits;
    r.providerState = outcome; r.chargedUnits = actualUnits; r.usage = metadata; r.settlementHash = digest;
  }
  function admit(bound, { reserveUnits = 0, available = true } = {}) {
    // These arguments are selected server policy, NOT client costs or allowCloud.
    units(reserveUnits);
    auth(bound.scope);
    const s = get(bound.scope);
    if (bound.taskId) {
      const named = s.tasks.get(bound.taskId);
      if (!named) fail('missing', 404);
      if (named.bodyHash !== bound.bodyHash || named.routeScope !== bound.routeScope || (bound.binding && s.bindings.get(bound.binding) !== named.taskId)) fail('hash_conflict', 409);
      return reply(named);
    }
    const priorId = bound.binding && s.bindings.get(bound.binding);
    if (priorId) {
      const prior = s.tasks.get(priorId);
      if (prior.bodyHash !== bound.bodyHash || prior.routeScope !== bound.routeScope || prior.parentTaskId !== bound.parentTaskId) fail('hash_conflict', 409);
      return reply(prior); // includes stopped/unknown/failed. Explicit keys only, no TTL resurrection.
    }
    let parent = null;
    if (bound.parentTaskId) {
      parent = s.tasks.get(bound.parentTaskId);
      if (!parent || parent.routeScope !== bound.routeScope || parent.bodyHash !== bound.parentHash) fail('parent', 403);
      if (parent.status !== 'stopped' || !parent.settlementHash) fail('parent_unsettled', 409);
      if (parent.childTaskId || parent.depth >= maxDepth) fail('lineage_limit', 409);
    }
    if (!available) fail('unavailable', 503);
    if (s.tasks.size >= maxTasks) fail('task_limit', 429);
    if (reserveUnits > s.limitUnits - s.spent - s.reserved) fail('budget', 429);
    const taskId = token().slice(0, 32), storeToken = token();
    const r = { taskId, parentTaskId: bound.parentTaskId, bodyHash: bound.bodyHash, routeScope: bound.routeScope,
      depth: parent ? parent.depth + 1 : 0, childTaskId: null, tokenHash: sha(storeToken), reserveUnits,
      chargedUnits: null, settlementHash: null, providerState: 'not_started', status: 'pending', started: false, response: null };
    s.tasks.set(taskId, r); if (bound.binding) s.bindings.set(bound.binding, taskId); s.reserved += reserveUnits;
    if (parent) parent.childTaskId = taskId;
    return { ...reply(r, false), taskId, storeToken };
  }
  function find(scope, taskId) {
    const s = get(scope), r = s.tasks.get(taskId);
    if (!r) fail('missing', 404);
    return { s, r };
  }
  function start(scope, taskId, storeToken) {
    const { s, r } = find(scope, taskId); checkToken(r, storeToken);
    if (!live(scope)) {
      if (r.status === 'pending') {
        settle(s, r, { outcome: 'not_committed' }); r.status = 'stopped';
        r.response = { taskId, parentTaskId: r.parentTaskId, status: 'stopped', text: null };
      }
      fail('auth', 401);
    }
    if (r.status !== 'pending' || r.started) return { execute: false, ...reply(r) };
    r.started = true; r.status = 'running'; r.providerState = 'unknown';
    return { execute: true, taskId }; // only this CAS winner may call the provider
  }
  function finish(scope, taskId, storeToken, result) {
    const { s, r } = find(scope, taskId); checkToken(r, storeToken);
    const validText = result.completed === true && typeof result.text === 'string' && result.text.trim().length > 0;
    if (result.completed === true && (!validText || !r.started || result.outcome !== 'committed')) fail('invalid_generation');
    // A stopped terminal response never changes; settlement may still reconcile its held budget.
    const proposed = { taskId, parentTaskId: r.parentTaskId, status: validText ? 'completed' : 'failed', text: validText ? result.text : null };
    const responseHash = sha(canonical(proposed));
    if (r.finishHash && r.finishHash !== responseHash) fail('response_conflict', 409);
    settle(s, r, result);
    if (result.outcome === 'unknown') return reply(r); // hold, do NOT retry generation
    r.finishHash = responseHash;
    if (!terminal(r.status)) { r.status = proposed.status; r.response = proposed; }
    return reply(r);
  }
  function stop(scope, taskId) {
    auth(scope);
    const { s, r } = find(scope, taskId);
    if (terminal(r.status)) return reply(r);
    if (!r.started) settle(s, r, { outcome: 'not_committed' });
    r.status = 'stopped'; s.stoppedScopes.add(r.routeScope);
    r.response = { taskId, parentTaskId: r.parentTaskId, status: 'stopped', text: null };
    return reply(r);
  }
  function read(scope, taskId) { auth(scope); return reply(find(scope, taskId).r); }
  return { provision, snapshot, admit, start, finish, stop, read };
}

// Boundary wrapper: auth is checked anew before EACH operation, including replay/GET/stop.
// A remote transport failure NEVER implicitly falls back to this memory implementation.
export function createTaskService(store, { hashKey, verifyAuth }) {
  const authenticate = async credential => {
    let auth; try { auth = await verifyAuth(credential); } catch { fail('auth', 401); }
    if (!auth || auth.verified !== true || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()) fail('auth', 401);
    if (!auth.tenantId || !auth.subject) fail('auth', 401);
    return auth;
  };
  return {
    async invoke(credential, request, effective, policy) {
      const auth = await authenticate(credential);
      return store.admit(bindInvocation({ auth, request, effective, hashKey }), policy);
    },
    async read(credential, taskId) { return store.read(await authenticate(credential), taskId); },
    async stop(credential, taskId) { return store.stop(await authenticate(credential), taskId); },
  };
}
export function requireStorage(kind, environment) {
  if (kind === 'memory' && ['development', 'test'].includes(environment)) return kind;
  if (['upstash', 'supabase'].includes(kind)) return kind;
  fail('durable_store_required', 503);
}
