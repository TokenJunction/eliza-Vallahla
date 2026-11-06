import { createHash, createHmac } from 'node:crypto';

export class TaskError extends Error {
  constructor(reason, status = 400) { super(reason); this.reason = reason; this.status = status; }
}
export const fail = (reason, status = 400) => { throw new TaskError(reason, status); };
export const sha = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  const active = new Set(); let nodes = 0;
  function visit(v, depth) {
    if (++nodes > 4096 || depth > 24) fail('canonical_limit');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) fail('invalid_number');
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    }
    if (typeof v !== 'object') fail('invalid_json_type');
    if (active.has(v)) fail('cyclic_json');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail('non_plain_json');
    if (Reflect.ownKeys(v).some(k => typeof k !== 'string' || Object.getOwnPropertyDescriptor(v, k).get || Object.getOwnPropertyDescriptor(v, k).set)) fail('invalid_json_property');
    active.add(v);
    let result;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) fail('sparse_or_decorated_array');
      result = '[' + v.map(x => visit(x, depth + 1)).join(',') + ']';
    } else result = '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + visit(v[k], depth + 1)).join(',') + '}';
    active.delete(v); return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 65536) fail('canonical_limit');
  return result;
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max) fail('invalid_' + name);
  return value;
}
function noSecrets(value) {
  // This subtree is model parameters / tool route metadata, NOT messages or arbitrary tool arguments.
  const raw = canonical(value);
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    for (const [key, val] of Object.entries(v)) {
      if (/secret|password|authorization|api.?key|token|prompt|messages|text|headers|credential/i.test(key) && !/^(max_tokens|max_output_tokens)$/.test(key)) fail('unsafe_selected_field');
      walk(val);
    }
  };
  walk(value); return JSON.parse(raw);
}
export function scopeKey(scope) { return sha(canonical([scope.tenantId, scope.subject])); }
export function redisKey(scope) { return `vh:task:{${scopeKey(scope)}}:v1`; }

// auth/effective are server-only values, never spread from request JSON. The caller must
// revalidate its live session and authorize app/workspace/conversation/route first.
export function bindInvocation({ auth, request = {}, effective, hashKey, now = Date.now() }) {
  if (!auth || auth.verified !== true || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= now) fail('auth', 401);
  if (typeof hashKey !== 'string' || Buffer.byteLength(hashKey) < 32) fail('hash_key_unavailable', 503);
  const scope = { tenantId: text(auth.tenantId, 'tenant'), subject: text(auth.subject, 'subject'),
    authRef: createHmac('sha256', hashKey || '').update(text(auth.sessionId, 'session_id')).digest('hex') };
  if (!['member', 'owner'].includes(auth.sessionRole) || !Number.isSafeInteger(auth.authVersion) || auth.authVersion < 1 || auth.authVersion > 2147483647) fail('auth', 401);
  scope.authVersion = auth.authVersion; scope.sessionRole = auth.sessionRole;
  if (!effective || effective.authorized !== true) fail('policy', 403);
  const e = effective;
  const app = text(e.app, 'app'), conversationId = text(e.conversationId, 'conversation');
  const route = e.route;
  if (!route || !['local', 'cloud', 'service'].includes(route.transport)) fail('invalid_route');
  if (!Array.isArray(e.authorizedRoles) || !e.authorizedRoles.every(x => typeof x === 'string')) fail('invalid_authorized_roles');
  const selected = {
    version: 1, ...scope, sessionRole: auth.sessionRole,
    workspaceId: text(e.workspaceId, 'workspace'), conversationId, app,
    capability: text(e.capability, 'capability'), engine: text(e.engine, 'engine'),
    authorizedRoles: [...new Set(e.authorizedRoles)].sort(), policyVersion: text(e.policyVersion, 'policy_version'),
    route: { provider: text(route.provider, 'provider'), model: text(route.model, 'model'),
      transport: route.transport, endpointId: text(route.endpointId, 'endpoint_id'),
      params: noSecrets(route.params ?? {}) },
    toolRoutes: noSecrets(e.toolRoutes ?? []), fallbackRoutes: noSecrets(e.fallbackRoutes ?? []),
    executionPolicy: noSecrets(e.executionPolicy ?? {}),
    // Hash all actual sanitized content via a keyed digest; no prompt/plaintext, keys,
    // credentials or raw request order is stored, traced, or embedded in the canonical DTO.
    inputDigest: createHmac('sha256', hashKey).update(canonical(e.input)).digest('hex'),
  };
  const bodyHash = createHmac('sha256', hashKey).update(canonical(selected)).digest('hex');
  const taskId = request.taskId == null ? null : text(request.taskId, 'task_id');
  const parentTaskId = request.parentTaskId == null ? null : text(request.parentTaskId, 'parent_id');
  if (taskId && parentTaskId) fail('ambiguous_identity');
  const continuation = e.continuation;
  let parentHash = null;
  if (parentTaskId) {
    if (!continuation || continuation.allowed !== true || continuation.parentTaskId !== parentTaskId ||
        !/^[a-f0-9]{64}$/.test(continuation.parentHash || '')) fail('parent_approval', 403);
    parentHash = continuation.parentHash;
  }
  const key1 = request.idempotencyKey, key2 = request.clientRequestId;
  if (key1 != null && key2 != null && String(key1).toLowerCase() !== String(key2).toLowerCase()) fail('idempotency_mismatch');
  const idempotencyKey = key1 ?? key2 ?? null;
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))) fail('invalid_idempotency_key');
  const base = [scope.tenantId, scope.subject, scope.authRef, selected.workspaceId, conversationId, app];
  const routeScope = sha(canonical(base));
  // Only an explicit retry key deduplicates, NOT equal prompts or equal body hashes.
  const binding = idempotencyKey === null ? null : idempotencyKey.toLowerCase();
  return Object.freeze({ scope, bodyHash, binding, routeScope, taskId, parentTaskId, parentHash });
}
