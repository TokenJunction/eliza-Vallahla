'use strict';

// Server-only device grant authority. Not wired into the main engine.
// This module does not perform 2FA, does not issue device certificates,
// and does not store private keys or browser secrets.
// Cloud spend defaults to 0 micro-USD. Jupiter is not a privilege here.
// A missing store, or an unknown production mode without a durable store,
// is not ready and fails closed. AUTH_DO unavailable does not mint a grant.

const crypto = require('node:crypto');

const CAPABILITIES = Object.freeze({
  LOCAL_GENERATE: 'local.generate',
  LOCAL_CHAT: 'local.chat',
});
const GRANT_TTL_MAX_MS = 120_000;
const GRANT_TTL_DEFAULT_MS = 30_000;
const LINK_TTL_MAX_MS = 10 * 60 * 1000;
const DEFAULT_CLOUD_CAP_MICROS = 0;
const MAX_CAP_MICROS = 1_000_000_000;
const MAX_BODY_BYTES = 256 * 1024;
const FORMAT_MAX_BYTES = 1024;
const NUM_PREDICT_MAX = 4096;
const PATHS = Object.freeze({
  'local.generate': '/api/generate',
  'local.chat': '/api/chat',
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OPTION_LIMITS = Object.freeze({
  num_predict: Object.freeze({ min: 1, max: NUM_PREDICT_MAX, int: true }),
  temperature: Object.freeze({ min: 0, max: 2, int: false }),
  top_p: Object.freeze({ min: 0, max: 1, int: false }),
  top_k: Object.freeze({ min: 1, max: 200, int: true }),
  seed: Object.freeze({ min: 0, max: 2147483647, int: true }),
  num_ctx: Object.freeze({ min: 1, max: 8192, int: true }),
  repeat_penalty: Object.freeze({ min: 0, max: 2, int: false }),
});
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);
const BRAND = new WeakSet();

function canonicalJson(value, seen = new Set()) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (kind !== 'object') throw new TypeError('unsupported_type_' + kind);
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  let out;
  if (Array.isArray(value)) out = '[' + value.map((item) => canonicalJson(item, seen)).join(',') + ']';
  else {
    out = '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key], seen)).join(',') + '}';
  }
  seen.delete(value);
  return out;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b) && left.length === right.length;
}

function isJwt(value) {
  return typeof value === 'string' && value.split('.').length === 3 && value.length > 20;
}

function bannedPath(value) {
  if (typeof value !== 'string') return false;
  const text = value.toLowerCase();
  return text.includes('/etc') || text.includes('\\') || text.includes('..') || text.includes('socket') || text.includes('%2f') || text.includes('%2e');
}

function fail(reason, extra) {
  return Object.assign({ ok: false, reason }, extra || {});
}

function normalizeCap(capMicros) {
  if (capMicros === undefined || capMicros === null) {
    return { ok: true, capMicros: DEFAULT_CLOUD_CAP_MICROS, source: 'default' };
  }
  if (!Number.isSafeInteger(capMicros) || capMicros < 0 || capMicros > MAX_CAP_MICROS) {
    return { ok: false, reason: 'cap_malformed', capMicros: DEFAULT_CLOUD_CAP_MICROS, source: 'rejected' };
  }
  return { ok: true, capMicros, source: 'explicit' };
}

function checkOption(key, value, { requirePredict }) {
  if (key === 'max_tokens' || key === 'maxTokens') return 'unlimited_max_tokens_rejected';
  const rule = OPTION_LIMITS[key];
  if (!rule) return 'option_not_allowed:' + key;
  if (value === undefined) return 'option_undefined:' + key;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'bad_option_value:' + key;
  if (rule.int && !Number.isSafeInteger(value)) return 'option_not_integer:' + key;
  if (value < rule.min || value > rule.max) return 'option_out_of_bounds:' + key;
  if (key === 'num_predict' && value > NUM_PREDICT_MAX) return 'num_predict_above_4096';
  if (!requirePredict && key === 'num_predict' && !Number.isSafeInteger(value)) return 'option_not_integer:num_predict';
  return '';
}

function normalizeOptions(options, { requirePredict }) {
  if (options === undefined) {
    if (requirePredict) return fail('num_predict_required');
    return { ok: true, options: {} };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fail('bad_options');
  if (!requirePredict && Object.keys(options).length === 0) return { ok: true, options: {} };
  if (requirePredict && !Object.prototype.hasOwnProperty.call(options, 'num_predict')) return fail('num_predict_required');
  const out = {};
  for (const key of Object.keys(options).sort()) {
    const problem = checkOption(key, options[key], { requirePredict });
    if (problem) return fail(problem);
    out[key] = options[key];
  }
  return { ok: true, options: out };
}

function normalizeFormat(format) {
  if (format === undefined || format === null) return { ok: true, format: null };
  if (typeof format !== 'object' || Array.isArray(format)) return fail('format_not_object');
  let encoded;
  try { encoded = canonicalJson(format); } catch (error) { return fail(error.message || 'format_not_json'); }
  if (Buffer.byteLength(encoded, 'utf8') > FORMAT_MAX_BYTES) return fail('format_too_large');
  return { ok: true, format: JSON.parse(encoded) };
}

function effectiveRequest(capability, request) {
  if (!PATHS[capability]) throw new TypeError('capability_not_granted');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('bad_request');
  if (request.url !== undefined || request.baseUrl !== undefined || request.endpoint !== undefined) throw new TypeError('path_override_rejected');
  if (request.path !== undefined && request.path !== PATHS[capability]) throw new TypeError('path_not_allowed');
  if (bannedPath(request.path || '') || bannedPath(request.model || '') || bannedPath(String(request.url || ''))) {
    throw new TypeError('path_not_allowed');
  }
  if (typeof request.model !== 'string' || !MODEL_RE.test(request.model) || bannedPath(request.model)) throw new TypeError('bad_model');
  const requirePredict = capability === CAPABILITIES.LOCAL_GENERATE;
  const options = normalizeOptions(request.options, { requirePredict });
  if (!options.ok) throw new TypeError(options.reason);
  if (capability === CAPABILITIES.LOCAL_GENERATE) {
    if (request.stream !== false) throw new TypeError('stream_must_be_false');
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) throw new TypeError('bad_prompt');
    if (Buffer.byteLength(request.prompt, 'utf8') > MAX_BODY_BYTES) throw new TypeError('prompt_too_large');
    const format = normalizeFormat(request.format);
    if (!format.ok) throw new TypeError(format.reason);
    const body = {
      capability,
      path: PATHS[capability],
      model: request.model,
      prompt: request.prompt,
      stream: false,
      format: format.format,
      options: options.options,
    };
    if (Buffer.byteLength(canonicalJson(body), 'utf8') > MAX_BODY_BYTES) throw new TypeError('body_too_large');
    return body;
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 256) throw new TypeError('bad_messages');
  const messages = request.messages.map((message) => {
    if (!message || !CHAT_ROLES.has(message.role) || typeof message.content !== 'string') throw new TypeError('bad_message');
    return { role: message.role, content: message.content };
  });
  const body = {
    capability,
    path: PATHS[capability],
    model: request.model,
    messages,
    stream: true,
    options: options.options,
  };
  if (Buffer.byteLength(canonicalJson(body), 'utf8') > MAX_BODY_BYTES) throw new TypeError('body_too_large');
  return body;
}

function requestFingerprint(capability, request) {
  return fingerprint(effectiveRequest(capability, request));
}

function createMemoryStore() {
  const state = {
    grants: new Map(),
    idem: new Map(),
    tasks: new Set(),
    links: new Map(),
    ledger: new Map(),
    jobs: new Map(),
  };
  let locked = false;
  return {
    durable: false,
    kind: 'memory',
    transact(fn) {
      if (locked) return fail('store_reentered');
      locked = true;
      try { return fn(state); } finally { locked = false; }
    },
  };
}

function createDurableStore(adapter) {
  if (!adapter || adapter.singleWriter !== true || typeof adapter.transact !== 'function') {
    throw new TypeError('durable_adapter_required');
  }
  return {
    durable: true,
    kind: 'durable',
    transact(fn) {
      return adapter.transact(fn);
    },
  };
}

function assessReadiness({ store, production } = {}) {
  if (!store || typeof store.transact !== 'function') return { ready: false, reason: 'store_absent', durable: false };
  if (store.durable === true && store.kind === 'durable') return { ready: true, reason: 'durable_store', durable: true };
  if (production === false && store.kind === 'memory') return { ready: true, reason: 'memory_dev_only', durable: false };
  if (production !== true && production !== false) return { ready: false, reason: 'production_unknown', durable: false };
  return { ready: false, reason: 'durable_store_required', durable: false };
}

function isServerPrincipal(principal) {
  return !!principal && typeof principal === 'object' && BRAND.has(principal);
}

function resolver(authDo, name, args) {
  if (!authDo || authDo.available !== true || typeof authDo[name] !== 'function') return fail('auth_do_unavailable');
  try {
    return { ok: true, value: authDo[name](...args) };
  } catch {
    return fail('auth_do_unavailable');
  }
}

function createIdentityManager({ store, production, authDo } = {}) {
  const readiness = assessReadiness({ store, production });

  function closed(reason) {
    return fail(reason || readiness.reason, { readiness: false });
  }

  function runStore(fn) {
    if (!readiness.ready) return closed();
    try {
      const result = store.transact(fn);
      if (result && result.ok === false && result.reason === 'store_reentered') return result;
      return result;
    } catch {
      return fail('store_failed', { readiness: true });
    }
  }

  function run(fn) {
    if (!authDo || authDo.available !== true) return fail('auth_do_unavailable', { readiness: readiness.ready, synthetic: false });
    return runStore(fn);
  }

  function adoptVerifiedSession(record) {
    if (!readiness.ready) return closed();
    if (!authDo || authDo.available !== true) return fail('auth_do_unavailable', { synthetic: false });
    if (!record || typeof record !== 'object') return fail('identity_required');
    if (record.active !== true) return fail('subject_inactive');
    if (isJwt(record.jwt) || isJwt(record.token) || isJwt(record.accessToken) || record.jwt || record.accessToken) {
      return fail('jwt_not_used');
    }
    if (typeof record.subject !== 'string' || !record.subject || typeof record.tenantId !== 'string' || !record.tenantId) {
      return fail('identity_required');
    }
    if (!Number.isSafeInteger(record.sessionVersion) || record.sessionVersion < 0) return fail('session_version_required');
    const live = resolver(authDo, 'sessionVersion', [record.subject, record.tenantId]);
    if (!live.ok) return fail('auth_do_unavailable', { synthetic: false });
    if (live.value !== record.sessionVersion) return fail('session_version_mismatch');
    const active = resolver(authDo, 'sessionActive', [record.subject, record.tenantId]);
    if (!active.ok || active.value !== true) return fail('auth_do_unavailable', { synthetic: false });
    const serverRole = record.roleSource === 'auth-do' && record.serverRole === 'owner' ? 'owner' : 'member';
    const principal = Object.freeze({
      subject: record.subject,
      tenantId: record.tenantId,
      serverRole,
      sessionVersion: record.sessionVersion,
      source: 'auth-do',
      jupiter: false,
      capMicros: DEFAULT_CLOUD_CAP_MICROS,
      clientRoleIgnored: true,
    });
    BRAND.add(principal);
    return {
      ok: true,
      principal,
      discarded: { role: record.role, clientRole: record.clientRole, jupiter: record.jupiter, caps: record.caps },
    };
  }

  function selectTaskId() {
    return run((state) => {
      const taskId = 'tsk_' + randomId(16);
      state.tasks.add(taskId);
      return { ok: true, taskId, source: 'server' };
    });
  }

  function reserve(input) {
    const cap = normalizeCap(input && input.capMicros);
    // Budget uses the store only. A grant still cannot be minted without AUTH_DO.
    if (!cap.ok) return fail('cap_malformed', { capMicros: 0, chargedMicros: 0, coincident: false });
    if (!input || typeof input !== 'object') return fail('bad_request', { capMicros: cap.capMicros, chargedMicros: 0 });
    if (input.capability === 'jupiter' || input.route === 'jupiter') {
      return fail('jupiter_not_privileged', { capMicros: cap.capMicros, chargedMicros: 0 });
    }
    return runStore((state) => {
      const tenantId = input.tenantId;
      const taskId = input.taskId;
      if (typeof tenantId !== 'string' || !tenantId || typeof taskId !== 'string' || !taskId) return fail('budget_identity_required');
      const jobKey = tenantId + '\n' + taskId;
      const prior = state.jobs.get(jobKey);
      if (input.route === 'local') {
        // local work is a zero charge on the same ledger; it does not open cloud spend
        if (prior) return { ok: true, chargeMicros: 0, capMicros: cap.capMicros, coincident: true, taskId };
        state.jobs.set(jobKey, { chargeMicros: 0, route: 'local' });
        return { ok: true, chargeMicros: 0, capMicros: cap.capMicros, coincident: false, taskId };
      }
      if (input.route !== 'cloud') return fail('route_not_permitted', { capMicros: cap.capMicros, chargedMicros: 0 });
      if (cap.capMicros === 0) return fail('cloud_spend_cap_zero', { capMicros: 0, chargedMicros: 0 });
      if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros < 1) return fail('bad_amount', { capMicros: cap.capMicros, chargedMicros: 0 });
      if (prior) {
        if (prior.route !== 'cloud' || prior.chargeMicros !== input.amountMicros) return fail('budget_conflict', { chargedMicros: prior.chargeMicros || 0 });
        return { ok: true, chargeMicros: prior.chargeMicros, capMicros: cap.capMicros, coincident: true, taskId };
      }
      const bal = state.ledger.get(tenantId) || { usedMicros: 0 };
      const next = bal.usedMicros + input.amountMicros;
      if (!Number.isSafeInteger(next) || next > cap.capMicros) return fail('cloud_budget_exhausted', { capMicros: cap.capMicros, chargedMicros: 0 });
      state.ledger.set(tenantId, { usedMicros: next });
      state.jobs.set(jobKey, { chargeMicros: input.amountMicros, route: 'cloud' });
      return { ok: true, chargeMicros: input.amountMicros, capMicros: cap.capMicros, coincident: false, usedMicros: next, taskId };
    });
  }

  function releaseReservation(tenantId, taskId) {
    return runStore((state) => {
      const jobKey = tenantId + '\n' + taskId;
      const prior = state.jobs.get(jobKey);
      if (!prior) return { ok: true, released: false };
      if (prior.route === 'cloud' && prior.chargeMicros > 0 && !prior.released) {
        const bal = state.ledger.get(tenantId) || { usedMicros: 0 };
        state.ledger.set(tenantId, { usedMicros: Math.max(0, bal.usedMicros - prior.chargeMicros) });
      }
      prior.released = true;
      return { ok: true, released: true, chargeMicros: prior.chargeMicros || 0 };
    });
  }

  function issueGrant(input) {
    return run((state) => {
      const principal = input && input.principal;
      if (!isServerPrincipal(principal)) return fail('principal_not_server_issued');
      const capability = input.capability;
      if (capability === 'jupiter') return fail('jupiter_not_privileged');
      if (!PATHS[capability]) return fail('capability_not_granted');
      const connection = input.connection;
      if (!connection || connection.authenticated !== true || connection.active !== true) return fail('device_not_connected');
      if (connection.tenantId !== principal.tenantId || connection.subject !== principal.subject) return fail('tenant_mismatch');
      if (typeof connection.deviceId !== 'string' || !ID_RE.test(connection.deviceId)) return fail('bad_device');
      if (typeof connection.connectionId !== 'string' || !ID_RE.test(connection.connectionId)) return fail('bad_connection');
      if (typeof connection.activeId !== 'string' || !ID_RE.test(connection.activeId)) return fail('bad_active_id');
      if (isJwt(input.idempotencyKey) || isJwt(input.token)) return fail('jwt_not_used');
      if (typeof input.idempotencyKey !== 'string' || !UUID_V4.test(input.idempotencyKey)) return fail('idempotency_key_must_be_uuid_v4');
      if (/^[0-9a-f]{64}$/i.test(input.idempotencyKey)) return fail('idempotency_key_must_be_uuid_v4');
      if (typeof input.taskId !== 'string' || !state.tasks.has(input.taskId)) return fail('task_id_must_be_server_issued');
      if (!Number.isSafeInteger(input.now)) return fail('server_clock_required');
      const ttlMs = input.ttlMs === undefined ? GRANT_TTL_DEFAULT_MS : input.ttlMs;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > GRANT_TTL_MAX_MS) return fail('ttl_out_of_bounds');
      const allow = input.deviceAllowlist;
      if (!allow || allow.active !== true || allow.tenantId !== principal.tenantId || allow.subject !== principal.subject) return fail('device_grant_inactive');
      if (allow.deviceId !== connection.deviceId) return fail('device_mismatch');
      if (!Array.isArray(allow.models) || !allow.models.includes(input.request && input.request.model)) return fail('model_not_on_device_allowlist');
      if (!Array.isArray(allow.capabilities) || !allow.capabilities.includes(capability)) return fail('capability_not_granted');
      const sessionVersion = resolver(authDo, 'sessionVersion', [principal.subject, principal.tenantId]);
      const deviceVersion = resolver(authDo, 'deviceVersion', [connection.deviceId, principal.tenantId]);
      const sessionActive = resolver(authDo, 'sessionActive', [principal.subject, principal.tenantId]);
      const deviceActive = resolver(authDo, 'deviceActive', [connection.deviceId, principal.tenantId]);
      if (!sessionVersion.ok || !deviceVersion.ok || !sessionActive.ok || !deviceActive.ok) return fail('auth_do_unavailable', { synthetic: false });
      if (sessionActive.value !== true) return fail('session_revoked', { synthetic: false });
      if (deviceActive.value !== true) return fail('device_revoked');
      if (sessionVersion.value !== principal.sessionVersion || sessionVersion.value !== connection.sessionVersion) return fail('session_version_mismatch');
      if (!Number.isSafeInteger(deviceVersion.value) || deviceVersion.value !== connection.deviceVersion) return fail('device_version_mismatch');
      let body;
      try { body = effectiveRequest(capability, input.request); } catch (error) { return fail(error.message); }
      const fp = fingerprint(body);
      const scope = canonicalJson([principal.tenantId, principal.subject, input.idempotencyKey]);
      const priorId = state.idem.get(scope);
      if (priorId) {
        const prior = state.grants.get(priorId);
        if (!prior || prior.fingerprint !== fp) return fail('idempotency_key_reused_with_different_request');
        return { ok: true, duplicate: true, grantId: prior.grantId, state: prior.state, fingerprint: prior.fingerprint, browserStorage: false };
      }
      const grant = {
        grantId: 'gnt_' + randomId(18),
        nonce: randomId(32),
        tenantId: principal.tenantId,
        subject: principal.subject,
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
        activeId: connection.activeId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        capability,
        model: body.model,
        path: body.path,
        fingerprint: fp,
        sessionVersion: sessionVersion.value,
        deviceVersion: deviceVersion.value,
        issuedAt: input.now,
        expiresAt: input.now + ttlMs,
        state: 'issued',
        reservationReleased: false,
      };
      state.grants.set(grant.grantId, grant);
      state.idem.set(scope, grant.grantId);
      return {
        ok: true,
        duplicate: false,
        browserStorage: false,
        privateKey: undefined,
        grant: Object.assign({}, grant),
        request: body,
      };
    });
  }

  function consumeGrant(input) {
    return run((state) => {
      const grant = input && typeof input.grantId === 'string' ? state.grants.get(input.grantId) : undefined;
      if (!grant) return fail('unknown_grant');
      if (!Number.isSafeInteger(input.now)) return fail('server_clock_required');
      if (grant.state !== 'issued') return fail('grant_already_' + grant.state);
      if (!safeEqual(input.nonce, grant.nonce)) return fail('nonce_mismatch');
      if (input.now >= grant.expiresAt) {
        grant.state = 'expired';
        return fail('grant_expired');
      }
      const connection = input.connection;
      if (!connection) return fail('device_mismatch');
      if (connection.tenantId !== grant.tenantId || connection.subject !== grant.subject) return fail('tenant_mismatch');
      if (connection.deviceId !== grant.deviceId) return fail('device_mismatch');
      if (connection.connectionId !== grant.connectionId || connection.activeId !== grant.activeId) return fail('binding_mismatch');
      if (input.capability !== grant.capability) return fail('capability_mismatch');
      if (input.fingerprint !== grant.fingerprint) return fail('fingerprint_mismatch');
      const sessionVersion = resolver(authDo, 'sessionVersion', [grant.subject, grant.tenantId]);
      const deviceVersion = resolver(authDo, 'deviceVersion', [grant.deviceId, grant.tenantId]);
      const sessionActive = resolver(authDo, 'sessionActive', [grant.subject, grant.tenantId]);
      const deviceActive = resolver(authDo, 'deviceActive', [grant.deviceId, grant.tenantId]);
      if (!sessionVersion.ok || !deviceVersion.ok || !sessionActive.ok || !deviceActive.ok) return fail('auth_do_unavailable', { synthetic: false });
      if (deviceActive.value !== true) {
        grant.state = 'revoked';
        return fail('device_revoked');
      }
      if (sessionActive.value !== true) {
        grant.state = 'revoked';
        return fail('session_revoked');
      }
      if (sessionVersion.value !== grant.sessionVersion) {
        grant.state = 'revoked';
        return fail('session_version_mismatch');
      }
      if (deviceVersion.value !== grant.deviceVersion) {
        grant.state = 'revoked';
        return fail('device_version_mismatch');
      }
      grant.state = 'running';
      return { ok: true, grant: Object.assign({}, grant) };
    });
  }

  function revokeGrant(grantId) {
    return run((state) => {
      const grant = state.grants.get(grantId);
      if (!grant) return fail('unknown_grant');
      if (grant.state === 'issued' || grant.state === 'running') grant.state = 'revoked';
      return { ok: true, state: grant.state };
    });
  }

  function createLinkMetadata(input) {
    return run((state) => {
      const principal = input && input.principal;
      if (!isServerPrincipal(principal)) return fail('principal_not_server_issued');
      if (principal.serverRole !== 'owner') return fail('owner_required');
      if (input.ownerStepUp !== true) return fail('owner_step_up_required', { twoFactorImplemented: false });
      if (principal.deviceId || input.requesterDeviceId) return fail('device_cannot_delegate');
      if (typeof input.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(input.host) || bannedPath(input.host)) return fail('bad_host');
      if (!Number.isSafeInteger(input.now)) return fail('server_clock_required');
      const ttlMs = input.ttlMs === undefined ? 5 * 60 * 1000 : input.ttlMs;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > LINK_TTL_MAX_MS) return fail('ttl_out_of_bounds');
      if (typeof input.publicKeyPem === 'string' && /PRIVATE KEY/.test(input.publicKeyPem)) {
        return fail('private_key_submitted', { twoFactorImplemented: false, browserStorage: false });
      }
      const nonceId = 'lnk_' + randomId(16);
      state.links.set(nonceId, {
        tenantId: principal.tenantId,
        subject: principal.subject,
        expiresAt: input.now + ttlMs,
        used: false,
      });
      return {
        ok: true,
        twoFactorImplemented: false,
        browserStorage: false,
        privateKey: undefined,
        certificateIssued: false,
        storageContract: 'os-secure-storage-not-implemented',
        metadata: { v: 1, host: input.host, nonceId, exp: input.now + ttlMs },
      };
    });
  }

  function redeemLink(input) {
    return run((state) => {
      if (input && input.requesterDeviceId) return fail('device_cannot_delegate');
      const row = input && state.links.get(input.nonceId);
      if (!row) return fail('unknown_link');
      if (row.used) return fail('link_already_used');
      row.used = true;
      if (!Number.isSafeInteger(input.now) || input.now >= row.expiresAt) return fail('link_expired');
      if (typeof input.publicKeyPem !== 'string' || input.publicKeyPem.length > 8192) return fail('bad_public_key');
      if (/PRIVATE KEY/.test(input.publicKeyPem)) return fail('private_key_submitted', { browserStorage: false });
      try {
        const key = crypto.createPublicKey(input.publicKeyPem);
        if (key.type !== 'public') return fail('private_key_submitted', { browserStorage: false });
      } catch {
        return fail('bad_public_key');
      }
      return {
        ok: true,
        browserStorage: false,
        privateKeyStored: false,
        certificateIssued: false,
        twoFactorImplemented: false,
        deviceId: 'dev_' + randomId(16),
        tenantId: row.tenantId,
        subject: row.subject,
      };
    });
  }

  return Object.freeze({
    readiness: readiness.ready,
    readinessReason: readiness.reason,
    durable: readiness.durable,
    twoFactorImplemented: false,
    jupiterPrivileged: false,
    adoptVerifiedSession,
    selectTaskId,
    reserve,
    releaseReservation,
    issueGrant,
    consumeGrant,
    revokeGrant,
    createLinkMetadata,
    redeemLink,
    requestFingerprint(capability, request) {
      try { return { ok: true, fingerprint: requestFingerprint(capability, request), request: effectiveRequest(capability, request) }; }
      catch (error) { return fail(error.message); }
    },
  });
}

function redactGrant(grant) {
  if (!grant) return { grant: 'none' };
  return {
    grant: String(grant.grantId).slice(0, 6) + '…',
    tenant: grant.tenantId,
    device: grant.deviceId,
    task: grant.taskId,
    model: grant.model,
    fp: String(grant.fingerprint).slice(0, 12),
    state: grant.state,
  };
}

module.exports = {
  CAPABILITIES,
  GRANT_TTL_MAX_MS,
  GRANT_TTL_DEFAULT_MS,
  DEFAULT_CLOUD_CAP_MICROS,
  MAX_BODY_BYTES,
  FORMAT_MAX_BYTES,
  NUM_PREDICT_MAX,
  createMemoryStore,
  createDurableStore,
  assessReadiness,
  createIdentityManager,
  requestFingerprint,
  effectiveRequest,
  canonicalJson,
  fingerprint,
  redactGrant,
  isServerPrincipal,
};
