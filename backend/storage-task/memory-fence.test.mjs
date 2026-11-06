import assert from 'node:assert/strict';
import test from 'node:test';
import { bindInvocation, TaskError } from './canonical.mjs';
import { createMemoryStore } from './memory.mjs';
import { validateWorkerIdentity } from './session-bridge.mjs';

const hashKey = 'h'.repeat(32);
const keyA = '11111111-1111-4111-8111-111111111111';
const keyB = '22222222-2222-4222-8222-222222222222';

function effective(text) {
  return {
    authorized: true,
    app: 'ai-workspace',
    conversationId: 'c1',
    workspaceId: 'ws',
    capability: 'chat',
    engine: 'forge',
    authorizedRoles: ['member'],
    policyVersion: 'v1',
    route: {
      provider: 'local',
      model: 'qwen2.5-coder:14b',
      transport: 'local',
      endpointId: 'loopback',
      params: { max_tokens: 16 },
    },
    input: { text },
  };
}

function auth(now = Date.now()) {
  return {
    verified: true,
    tenantId: 'tenant-a',
    subject: 'subject-a',
    sessionId: 'sid-1',
    sessionRole: 'member',
    authVersion: 1,
    expiresAt: now + 60_000,
  };
}

test('a memory fence admits once and rejects a revoked session', () => {
  let verified = true;
  const store = createMemoryStore({
    environment: 'test',
    authResolver(scope) {
      return {
        verified,
        tenantId: scope.tenantId,
        subject: scope.subject,
        authRef: scope.authRef,
        authVersion: scope.authVersion,
        sessionRole: scope.sessionRole,
        expiresAt: Date.now() + 60_000,
      };
    },
  });
  const named = bindInvocation({
    auth: auth(),
    request: { taskId: 'client-picked' },
    effective: effective('hello'),
    hashKey,
  });
  store.provision(named.scope, 10);
  assert.throws(() => store.admit(named, { reserveUnits: 0 }), (err) => err instanceof TaskError && err.status === 404);
  const bound = bindInvocation({
    auth: auth(),
    request: { idempotencyKey: keyA },
    effective: effective('hello'),
    hashKey,
  });
  const first = store.admit(bound, { reserveUnits: 1 });
  assert.equal(first.replay, false);
  assert.equal(first.response.status, 'pending');
  assert.notEqual(first.taskId, keyA);
  assert.equal(first.taskId.length, 32);
  const replay = store.admit(bindInvocation({
    auth: auth(),
    request: { idempotencyKey: keyA },
    effective: effective('hello'),
    hashKey,
  }));
  assert.equal(replay.replay, true);
  assert.equal(replay.response.taskId, first.taskId);
  const other = store.admit(bindInvocation({
    auth: auth(),
    request: { idempotencyKey: keyB },
    effective: effective('other'),
    hashKey,
  }), { reserveUnits: 1 });
  assert.notEqual(other.taskId, first.taskId);
  assert.throws(() => store.start(bound.scope, first.taskId, 'not-the-fence'), (err) => err instanceof TaskError && err.reason === 'fence');
  const started = store.start(bound.scope, first.taskId, first.storeToken);
  assert.equal(started.execute, true);
  assert.equal(store.start(bound.scope, first.taskId, first.storeToken).execute, false);
  verified = false;
  assert.throws(() => store.start(bound.scope, other.taskId, other.storeToken), (err) => err instanceof TaskError && err.status === 401);
  assert.equal(store.snapshot(bound.scope).reserved, 1);
});

test('the public access body is not a worker identity grant', () => {
  const now = 5_000;
  const subject = 'a'.repeat(64);
  assert.equal(validateWorkerIdentity({ ok: true, plan: 'free', subscriber: false, leader: true }, now).verified, false);
  const grant = validateWorkerIdentity({
    ok: true,
    subject,
    email_verified: true,
    sid: 'sid-1',
    role: 'admin',
    leader: true,
  }, now);
  assert.equal(grant.verified, true);
  assert.equal(grant.sessionRole, 'member');
  assert.equal(grant.supabaseAuthUid, null);
  assert.equal(grant.workerRoleIgnored, true);
  assert.equal(grant.subject, subject);
});

test('redis and sql fixtures are not executed here', async () => {
  const redis = await import('./redis.mjs');
  const supabase = await import('./supabase.mjs');
  assert.equal(typeof redis.createRedisStore, 'function');
  assert.equal(typeof supabase.createSupabaseStore, 'function');
  assert.equal(redis.createRedisStore.length >= 0, true);
  assert.throws(() => redis.createRedisStore({}), (err) => err.reason === 'storage_config');
});
