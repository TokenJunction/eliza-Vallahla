'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  CAPABILITIES,
  GRANT_TTL_MAX_MS,
  DEFAULT_CLOUD_CAP_MICROS,
  createMemoryStore,
  createDurableStore,
  createIdentityManager,
} = require('./IdentityManager');

const deviceId = 'dev-local-device-1';
const activeId = 'active-device-0001';
const model = 'qwen2.5-coder:14b';

function versions() {
  return { session: 1, deviceVersion: 4, active: true, device: true, calls: [] };
}

function authDo(state) {
  return {
    available: true,
    sessionActive(subject, tenantId) {
      state.calls.push('sessionActive');
      return state.active === true && subject === 'subject-1' && tenantId === 'tenant-1';
    },
    deviceActive(id, tenantId) {
      state.calls.push('deviceActive');
      return state.device === true && id === deviceId && tenantId === 'tenant-1';
    },
    sessionVersion(subject, tenantId) {
      state.calls.push(['sessionVersion', subject, tenantId]);
      return state.session;
    },
    deviceVersion(id, tenantId) {
      state.calls.push(['deviceVersion', id, tenantId]);
      return state.deviceVersion;
    },
  };
}

function manager(extra = {}, state = versions()) {
  return createIdentityManager(Object.assign({
    production: false,
    store: createMemoryStore(),
    authDo: authDo(state),
  }, extra));
}

function principalOf(api, record) {
  const adopted = api.adoptVerifiedSession(Object.assign({
    active: true,
    subject: 'subject-1',
    tenantId: 'tenant-1',
    sessionVersion: 1,
    serverRole: 'member',
    roleSource: 'auth-do',
    role: 'owner',
    jupiter: true,
    caps: 999,
  }, record || {}));
  assert.equal(adopted.ok, true);
  return adopted.principal;
}

function connection(over = {}) {
  return Object.assign({
    authenticated: true,
    active: true,
    tenantId: 'tenant-1',
    subject: 'subject-1',
    deviceId,
    connectionId: 'con-local-socket-1',
    activeId,
    sessionVersion: 1,
    deviceVersion: 4,
  }, over);
}

function allow(capability) {
  return {
    active: true,
    tenantId: 'tenant-1',
    subject: 'subject-1',
    deviceId,
    models: [model],
    capabilities: [capability],
  };
}

function generateRequest(over = {}) {
  return Object.assign({
    model,
    prompt: 'Say hi',
    stream: false,
    options: { num_predict: 32, temperature: 0 },
  }, over);
}

function issue(api, principal, over = {}) {
  const task = api.selectTaskId();
  assert.equal(task.ok, true);
  const granted = api.issueGrant(Object.assign({
    principal,
    capability: CAPABILITIES.LOCAL_GENERATE,
    connection: connection(),
    taskId: task.taskId,
    idempotencyKey: crypto.randomUUID(),
    request: generateRequest(),
    now: 1_700_000_000_000,
    ttlMs: 30_000,
    deviceAllowlist: allow(CAPABILITIES.LOCAL_GENERATE),
  }, over));
  return { task, granted };
}

test('a client role, Jupiter flag, and client cap do not become authority', () => {
  const api = manager();
  const principal = principalOf(api);
  assert.equal(principal.serverRole, 'member');
  assert.equal(principal.jupiter, false);
  assert.equal(principal.capMicros, DEFAULT_CLOUD_CAP_MICROS);
  assert.equal(principal.subject, 'subject-1');
  assert.equal(principal.tenantId, 'tenant-1');
  assert.equal(principal.clientRoleIgnored, true);
  assert.equal(api.jupiterPrivileged, false);
  assert.equal(api.twoFactorImplemented, false);
});

test('cloud cap defaults to zero, a bad number stays zero, and one task reserves once', () => {
  const api = manager();
  const malformed = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_one', amountMicros: 10, capMicros: 1.5 });
  assert.equal(malformed.reason, 'cap_malformed');
  assert.equal(malformed.capMicros, 0);
  assert.equal(malformed.chargedMicros, 0);
  const absent = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_one', amountMicros: 10 });
  assert.equal(absent.reason, 'cloud_spend_cap_zero');
  assert.equal(absent.capMicros, 0);
  const jupiter = api.reserve({ route: 'jupiter', tenantId: 'tenant-1', taskId: 'tsk_j', amountMicros: 1, capMicros: 100 });
  assert.equal(jupiter.reason, 'jupiter_not_privileged');
  const local = api.reserve({ route: 'local', tenantId: 'tenant-1', taskId: 'tsk_local', capMicros: 100 });
  const localAgain = api.reserve({ route: 'local', tenantId: 'tenant-1', taskId: 'tsk_local', capMicros: 100 });
  assert.equal(local.chargeMicros, 0);
  assert.equal(localAgain.coincident, true);
  assert.equal(localAgain.chargeMicros, 0);
  const first = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_cloud', amountMicros: 40, capMicros: 100 });
  const again = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_cloud', amountMicros: 40, capMicros: 100 });
  assert.equal(first.ok, true);
  assert.equal(first.coincident, false);
  assert.equal(again.coincident, true);
  assert.equal(again.chargeMicros, 40);
  const second = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_other', amountMicros: 40, capMicros: 100 });
  assert.equal(second.usedMicros, 80);
  const overflow = api.reserve({ route: 'cloud', tenantId: 'tenant-1', taskId: 'tsk_over', amountMicros: 40, capMicros: 100 });
  assert.equal(overflow.reason, 'cloud_budget_exhausted');
});

test('an unknown production mode or a missing store fails closed and AUTH_DO mints nothing', () => {
  const unknown = createIdentityManager({ store: createMemoryStore() });
  assert.equal(unknown.readiness, false);
  assert.equal(unknown.readinessReason, 'production_unknown');
  assert.equal(unknown.issueGrant({}).readiness, false);
  assert.equal(unknown.issueGrant({}).grant, undefined);
  const absent = createIdentityManager({ production: false });
  assert.equal(absent.readinessReason, 'store_absent');
  const memoryInProd = createIdentityManager({ production: true, store: createMemoryStore(), authDo: { available: true } });
  assert.equal(memoryInProd.readinessReason, 'durable_store_required');
  const down = createIdentityManager({ production: false, store: createMemoryStore(), authDo: { available: false } });
  assert.equal(down.readiness, true);
  const minted = down.issueGrant({ capability: CAPABILITIES.LOCAL_GENERATE });
  assert.equal(minted.reason, 'auth_do_unavailable');
  assert.equal(minted.synthetic, false);
  assert.equal(minted.grant, undefined);
  assert.equal(down.adoptVerifiedSession({ active: true, subject: 'subject-1', tenantId: 'tenant-1' }).reason, 'auth_do_unavailable');
});

test('a durable guard is required in production and a JWT is not a session', () => {
  const state = versions();
  let depth = 0;
  const memory = createMemoryStore();
  const store = createDurableStore({
    singleWriter: true,
    transact(fn) {
      depth += 1;
      try { return memory.transact(fn); } finally { depth -= 1; }
    },
  });
  const live = authDo(state);
  const depths = [];
  const wrapped = Object.assign({}, live, {
    sessionVersion(subject, tenantId) {
      depths.push(depth);
      return live.sessionVersion(subject, tenantId);
    },
  });
  const api = createIdentityManager({ production: true, store, authDo: wrapped });
  assert.equal(api.readiness, true);
  assert.equal(api.durable, true);
  const jwt = api.adoptVerifiedSession({
    active: true,
    subject: 'subject-1',
    tenantId: 'tenant-1',
    sessionVersion: 1,
    jwt: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signaturevalue',
  });
  assert.equal(jwt.reason, 'jwt_not_used');
  const principal = principalOf(api);
  const { granted } = issue(api, principal);
  assert.equal(granted.ok, true);
  assert.equal(granted.browserStorage, false);
  assert.equal(granted.privateKey, undefined);
  assert.equal(depth, 0);
  const consumed = api.consumeGrant({
    grantId: granted.grant.grantId,
    nonce: granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: granted.grant.fingerprint,
    now: granted.grant.issuedAt + 10,
    connection: connection(),
  });
  assert.equal(consumed.ok, true);
  assert.equal(depths.includes(1), true);
});

test('grants are single use, short lived, and bound to the server task and uuid key', () => {
  const api = manager();
  const principal = principalOf(api);
  const tooLong = issue(api, principal, { ttlMs: GRANT_TTL_MAX_MS + 1 });
  assert.equal(tooLong.granted.reason, 'ttl_out_of_bounds');
  const hashed = issue(api, principal, { idempotencyKey: 'ab'.repeat(32) });
  assert.equal(hashed.granted.reason, 'idempotency_key_must_be_uuid_v4');
  const clientTask = issue(api, principal, { taskId: 'client-task-id-0001' });
  assert.equal(clientTask.granted.reason, 'task_id_must_be_server_issued');
  const key = '11111111-1111-4111-8111-111111111111';
  const first = issue(api, principal, { idempotencyKey: key, ttlMs: GRANT_TTL_MAX_MS });
  assert.equal(first.granted.ok, true);
  assert.equal(first.granted.grant.path, '/api/generate');
  assert.equal(first.granted.grant.capability, CAPABILITIES.LOCAL_GENERATE);
  assert.notEqual(first.granted.grant.taskId, undefined);
  const duplicate = api.issueGrant({
    principal,
    capability: CAPABILITIES.LOCAL_GENERATE,
    connection: connection(),
    taskId: first.task.taskId,
    idempotencyKey: key,
    request: generateRequest(),
    now: 1_700_000_000_000,
    ttlMs: GRANT_TTL_MAX_MS,
    deviceAllowlist: allow(CAPABILITIES.LOCAL_GENERATE),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.grantId, first.granted.grant.grantId);
  const clash = api.issueGrant({
    principal,
    capability: CAPABILITIES.LOCAL_GENERATE,
    connection: connection(),
    taskId: first.task.taskId,
    idempotencyKey: key,
    request: generateRequest({ prompt: 'Different' }),
    now: 1_700_000_000_000,
    deviceAllowlist: allow(CAPABILITIES.LOCAL_GENERATE),
  });
  assert.equal(clash.reason, 'idempotency_key_reused_with_different_request');
  const badNonce = api.consumeGrant({
    grantId: first.granted.grant.grantId,
    nonce: 'wrong-nonce-value',
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: first.granted.grant.fingerprint,
    now: first.granted.grant.issuedAt + 5,
    connection: connection(),
  });
  assert.equal(badNonce.reason, 'nonce_mismatch');
  const good = api.consumeGrant({
    grantId: first.granted.grant.grantId,
    nonce: first.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: first.granted.grant.fingerprint,
    now: first.granted.grant.issuedAt + 5,
    connection: connection(),
  });
  assert.equal(good.ok, true);
  const replay = api.consumeGrant({
    grantId: first.granted.grant.grantId,
    nonce: first.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: first.granted.grant.fingerprint,
    now: first.granted.grant.issuedAt + 6,
    connection: connection(),
  });
  assert.equal(replay.reason, 'grant_already_running');
});

test('expiry, revocation, tenant, and device checks happen before a grant can run', () => {
  const state = versions();
  const api = manager({}, state);
  const principal = principalOf(api);
  const { granted } = issue(api, principal, { ttlMs: 5_000 });
  const expired = api.consumeGrant({
    grantId: granted.grant.grantId,
    nonce: granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: granted.grant.fingerprint,
    now: granted.grant.expiresAt,
    connection: connection(),
  });
  assert.equal(expired.reason, 'grant_expired');
  const closed = api.consumeGrant({
    grantId: granted.grant.grantId,
    nonce: granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: granted.grant.fingerprint,
    now: granted.grant.issuedAt + 1,
    connection: connection(),
  });
  assert.equal(closed.reason, 'grant_already_expired');

  const second = issue(api, principal);
  assert.equal(api.consumeGrant({
    grantId: second.granted.grant.grantId,
    nonce: second.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: second.granted.grant.fingerprint,
    now: second.granted.grant.issuedAt + 1,
    connection: connection({ tenantId: 'other-tenant' }),
  }).reason, 'tenant_mismatch');
  assert.equal(api.consumeGrant({
    grantId: second.granted.grant.grantId,
    nonce: second.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: second.granted.grant.fingerprint,
    now: second.granted.grant.issuedAt + 1,
    connection: connection({ deviceId: 'dev-other-device-1' }),
  }).reason, 'device_mismatch');
  state.device = false;
  assert.equal(api.consumeGrant({
    grantId: second.granted.grant.grantId,
    nonce: second.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: second.granted.grant.fingerprint,
    now: second.granted.grant.issuedAt + 1,
    connection: connection(),
  }).reason, 'device_revoked');

  state.device = true;
  const third = issue(api, principal);
  state.session = 2;
  assert.equal(api.consumeGrant({
    grantId: third.granted.grant.grantId,
    nonce: third.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: third.granted.grant.fingerprint,
    now: third.granted.grant.issuedAt + 1,
    connection: connection(),
  }).reason, 'session_version_mismatch');
  assert.equal(api.revokeGrant(third.granted.grant.grantId).ok, true);
});

test('generate and chat are separate, and path overrides are rejected', () => {
  const api = manager();
  const principal = principalOf(api);
  const chat = issue(api, principal, {
    capability: CAPABILITIES.LOCAL_CHAT,
    deviceAllowlist: allow(CAPABILITIES.LOCAL_CHAT),
    request: {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      options: { temperature: 1 },
    },
  });
  assert.equal(chat.granted.ok, true);
  assert.equal(chat.granted.grant.path, '/api/chat');
  assert.equal(api.consumeGrant({
    grantId: chat.granted.grant.grantId,
    nonce: chat.granted.grant.nonce,
    capability: CAPABILITIES.LOCAL_GENERATE,
    fingerprint: chat.granted.grant.fingerprint,
    now: chat.granted.grant.issuedAt + 1,
    connection: connection(),
  }).reason, 'capability_mismatch');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ model: '/etc/passwd' })).reason, 'path_not_allowed');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ model: 'unix-socket' })).reason, 'path_not_allowed');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ path: '/etc/hostname' })).reason, 'path_not_allowed');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ url: 'http://127.0.0.1/socket' })).reason, 'path_override_rejected');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ options: { temperature: 1 } })).reason, 'num_predict_required');
  assert.equal(api.requestFingerprint(CAPABILITIES.LOCAL_GENERATE, generateRequest({ options: { num_predict: 4097 } })).reason, 'option_out_of_bounds:num_predict');
  const jupiter = api.issueGrant({
    principal,
    capability: 'jupiter',
    connection: connection(),
    taskId: chat.task.taskId,
    idempotencyKey: crypto.randomUUID(),
    request: generateRequest(),
    now: 1_700_000_000_000,
    deviceAllowlist: allow('jupiter'),
  });
  assert.equal(jupiter.reason, 'jupiter_not_privileged');
});

test('link metadata requires owner step-up and does not store a private key or claim 2FA', () => {
  const api = manager();
  const member = principalOf(api, { serverRole: 'member', role: 'owner', roleSource: 'client' });
  assert.equal(member.serverRole, 'member');
  assert.equal(api.createLinkMetadata({
    principal: member,
    ownerStepUp: true,
    host: 'link.example',
    now: 1_700_000_000_000,
  }).reason, 'owner_required');
  const owner = principalOf(api, { serverRole: 'owner', roleSource: 'auth-do', role: 'viewer' });
  const needsStep = api.createLinkMetadata({
    principal: owner,
    ownerStepUp: false,
    host: 'link.example',
    now: 1_700_000_000_000,
  });
  assert.equal(needsStep.reason, 'owner_step_up_required');
  assert.equal(needsStep.twoFactorImplemented, false);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const rejected = api.createLinkMetadata({
    principal: owner,
    ownerStepUp: true,
    host: 'link.example',
    now: 1_700_000_000_000,
    publicKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  assert.equal(rejected.reason, 'private_key_submitted');
  assert.equal(rejected.browserStorage, false);
  const link = api.createLinkMetadata({
    principal: owner,
    ownerStepUp: true,
    host: 'link.example',
    now: 1_700_000_000_000,
  });
  assert.equal(link.ok, true);
  assert.equal(link.twoFactorImplemented, false);
  assert.equal(link.browserStorage, false);
  assert.equal(link.certificateIssued, false);
  assert.equal(link.privateKey, undefined);
  assert.equal(link.storageContract, 'os-secure-storage-not-implemented');
  assert.equal(typeof link.metadata.nonceId, 'string');
  const burned = api.redeemLink({
    nonceId: link.metadata.nonceId,
    now: 1_700_000_000_000,
    publicKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  assert.equal(burned.reason, 'private_key_submitted');
  assert.equal(burned.browserStorage, false);
  const again = api.redeemLink({
    nonceId: link.metadata.nonceId,
    now: 1_700_000_000_000,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.equal(again.reason, 'link_already_used');
});
