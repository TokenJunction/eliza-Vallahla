import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { canonical, fail, redisKey, sha, TaskError } from './canonical.mjs';
import { units } from './memory.mjs';
const SCRIPT = readFileSync(new URL('./transaction.lua', import.meta.url), 'utf8');
const NOT_COMMITTED = sha(canonical({ outcome: 'not_committed', actualUnits: 0, usage: null }));

// Inject Upstash SDK eval(script, keys, args), not raw arbitrary endpoint fetch.
// There is ONE attempt. Unknown transport result => 503, reconcile by replay/read.
// Store token never goes to browser, SSE, trace or response JSON.
export function createRedisStore({ evalScript, ...options }) {
  if (typeof evalScript !== 'function') fail('storage_config', 503);
  return createRemoteStore({ ...options, transact: (scope, command) => evalScript(SCRIPT, [redisKey(scope)], [canonical(command)]) });
}

// Shared command protocol for Redis and the pending SQL fixture.
export function createRemoteStore({ transact, maxTasks = 1000, maxDepth = 2, authResolver, outputCodec }) {
  units(maxTasks); units(maxDepth);
  if (!outputCodec || typeof outputCodec.seal !== 'function' || typeof outputCodec.open !== 'function' || typeof authResolver !== 'function' || typeof transact !== 'function' || maxTasks < 1) fail('storage_config', 503);
  async function tx(scope, command) {
    if (['registerSession', 'admit', 'read', 'stop', 'start'].includes(command.op)) {
      let a; try { a = await authResolver(scope); } catch { a = null; }
      const live = a?.verified === true && a.tenantId === scope.tenantId && a.subject === scope.subject && a.authRef === scope.authRef && a.authVersion === scope.authVersion && a.sessionRole === scope.sessionRole && a.expiresAt > Date.now();
      // Revoke in the same atomic store before start so a pending reservation is
      // safely released. A transport failure remains unknown and is NOT refunded.
      if (live && command.op === 'registerSession') command = { ...command, expiresAt: Math.min(command.expiresAt, a.expiresAt) };
      if (!live) {
        if (command.op !== 'start') fail('auth', 401);
        await tx(scope, { op: 'revokeSession', authRef: scope.authRef });
      }
    }
    command = { ...command, authRef: scope.authRef ?? null, authVersion: scope.authVersion ?? null, sessionRole: scope.sessionRole ?? null };
    let out;
    try {
      out = await transact(scope, command);
      if (typeof out === 'string') out = JSON.parse(out);
      if (!out || typeof out !== 'object') fail('storage_unavailable', 503);
    } catch { fail('storage_unavailable', 503); } // don't reflect URLs, keys, exceptions
    if (out.error) throw new TaskError(out.error, out.status);
    if (out.response?.text != null) {
      try { out.response.text = outputCodec.open(out.response.text, { scope, taskId: out.response.taskId }); }
      catch { fail('stored_response_unavailable', 503); }
    }
    return out;
  }
  return {
    provision: (scope, limitUnits) => tx(scope, { op: 'provision', limitUnits: units(limitUnits), maxTasks, maxDepth }),
    registerSession: (scope, expiresAt) => tx(scope, { op: 'registerSession', expiresAt: units(expiresAt) }),
    revokeSession: scope => tx(scope, { op: 'revokeSession' }),
    snapshot: scope => tx(scope, { op: 'snapshot' }),
    async admit(bound, { reserveUnits = 0, available = true } = {}) {
      const storeToken = randomBytes(32).toString('hex');
      const out = await tx(bound.scope, { op: 'admit', bound, reserveUnits: units(reserveUnits), available: available === true,
        taskId: randomBytes(16).toString('hex'), tokenHash: sha(storeToken) });
      return out.replay === false ? { ...out, storeToken } : out;
    },
    start: (scope, taskId, storeToken) => tx(scope, { op: 'start', taskId, tokenHash: sha(storeToken), notCommittedHash: NOT_COMMITTED }),
    stop: (scope, taskId) => tx(scope, { op: 'stop', taskId, notCommittedHash: NOT_COMMITTED }),
    read: (scope, taskId) => tx(scope, { op: 'read', taskId }),
    finish(scope, taskId, storeToken, result) {
      if (result.completed === true && (typeof result.text !== 'string' || !result.text.trim())) fail('invalid_generation');
      const usage = result.usage == null ? null : {};
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) if (result.usage?.[key] != null) usage[key] = units(result.usage[key]);
      const x = { completed: result.completed === true, text: result.completed === true ? result.text : null,
        outcome: result.outcome, actualUnits: units(result.actualUnits ?? 0), usage };
      const proposed = { taskId, parentTaskId: result.parentTaskId ?? null, status: x.completed ? 'completed' : 'failed', text: x.text };
      // parentTaskId is not supplied by callers; calculate response identity without it.
      // Lua verifies its own stored parent; taskId fixes lineage. Memory uses full response hash.
      delete proposed.parentTaskId;
      return tx(scope, { op: 'finish', taskId, tokenHash: sha(storeToken), result: { ...x, text: x.text === null ? null : outputCodec.seal(x.text, { scope, taskId }) },
        responseHash: sha(canonical(proposed)), settlementHash: sha(canonical({ outcome: x.outcome, actualUnits: x.actualUnits, usage })) });
    },
  };
}
