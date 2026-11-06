'use strict';

// Maps a Valhalla auth-worker proof to a customer UUID.
// The device token does not create a Supabase Auth session, so auth.uid()
// stays empty. Only the backend service role may read or insert the mapping.
// A customer row is not an admin grant and does not carry leader secrets.

const EMAIL_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER_IDENTITY = ['email', 'user_id', 'user-id', 'x-user-id', 'x-user-email', 'x-email', 'x-customer-id', 'customer_id'];

function headerValue(headers, name) {
  if (!headers) return '';
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] || '').trim() : '';
}

function headerIdentity(headers) {
  return HEADER_IDENTITY.some((name) => headerValue(headers, name) !== '');
}

const COPIED_IDENTITY = ['email', 'name', 'picture', 'user_id', 'userId', 'uid', 'customer_id', 'customerId', 'memberId'];

function copiedIdentity(proof) {
  return COPIED_IDENTITY.some((key) => proof && proof[key] != null && String(proof[key]).trim() !== '');
}

function planCustomerMapping(proof) {
  if (!proof || proof.ok !== true) return { ok: false, error: 'proof-required' };
  if (copiedIdentity(proof)) return { ok: false, error: 'copied-identity-rejected' };
  if (proof.tenant && proof.tenant !== 'valhalla') return { ok: false, error: 'tenant-rejected' };
  if (!EMAIL_HASH.test(String(proof.subject || ''))) return { ok: false, error: 'proof-required' };
  if (!proof.sessionId) return { ok: false, error: 'proof-required' };
  if (proof.code !== true && proof.google !== true) return { ok: false, error: 'proof-required' };
  const leader = proof.leader === true && proof.google === true && proof.code === true;
  return {
    ok: true,
    emailHash: String(proof.subject),
    sessionId: String(proof.sessionId),
    googleVerified: proof.google === true,
    leader,
    role: 'customer',
    adminSecrets: false,
    supabaseAuthUid: null,
    foundationAccess: false,
    tenant: 'valhalla',
  };
}

function publicMapping(plan, memberId) {
  return {
    ok: true,
    memberId,
    customerId: memberId,
    tenant: 'valhalla',
    sessionId: plan.sessionId,
    googleVerified: plan.googleVerified,
    leader: plan.leader,
    role: 'customer',
    adminSecrets: false,
    supabaseAuthUid: null,
    foundationAccess: false,
  };
}

function serviceRoleEnv(env) {
  const url = String(env && env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) return null;
  if (env.SUPABASE_ANON_KEY && key === env.SUPABASE_ANON_KEY) return null;
  return { url, key };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function mapCustomer({ proof, headers, env, fetchImpl }) {
  if (headerIdentity(headers)) return { ok: false, error: 'header-identity-rejected' };
  const plan = planCustomerMapping(proof);
  if (!plan.ok) return plan;
  const cfg = serviceRoleEnv(env);
  if (!cfg) return { ok: false, error: 'service-role-required' };
  if (env.VALHALLA_IDENTITY_DB !== 'tested') {
    return { ok: false, error: 'mapping-unproven', supabaseAuthUid: null, foundationAccess: false };
  }
  const doFetch = fetchImpl || fetch;
  const selectUrl = `${cfg.url}/rest/v1/customer_identity?tenant=eq.valhalla&email_hash=eq.${plan.emailHash}&select=customer_id,email_hash,tenant`;
  const headersForDb = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    Accept: 'application/json',
  };
  const found = await doFetch(selectUrl, { method: 'GET', headers: headersForDb });
  if (!found.ok) return { ok: false, error: 'mapping-failed' };
  const rows = await readJson(found);
  const existing = Array.isArray(rows) ? rows[0] : null;
  if (existing && existing.tenant === 'valhalla' && existing.email_hash === plan.emailHash && UUID.test(String(existing.customer_id || ''))) {
    return publicMapping(plan, existing.customer_id);
  }
  const inserted = await doFetch(`${cfg.url}/rest/v1/customer_identity`, {
    method: 'POST',
    headers: Object.assign({}, headersForDb, {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify({ email_hash: plan.emailHash, tenant: 'valhalla' }),
  });
  if (!inserted.ok) return { ok: false, error: 'mapping-failed' };
  const createdRows = await readJson(inserted);
  const created = Array.isArray(createdRows) ? createdRows[0] : null;
  if (!created || created.tenant !== 'valhalla' || !UUID.test(String(created.customer_id || ''))) {
    return { ok: false, error: 'mapping-failed' };
  }
  return publicMapping(plan, created.customer_id);
}

async function mapCustomerFromBearer({ authBase, bearer, headers, env, fetchImpl }) {
  if (headerIdentity(headers)) return { ok: false, error: 'header-identity-rejected' };
  const base = String(authBase || '').replace(/\/+$/, '');
  const token = String(bearer || '').trim();
  if (!base || !token) return { ok: false, error: 'proof-required' };
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${base}/auth/access`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) return { ok: false, error: 'proof-rejected' };
  const proof = await response.json();
  return mapCustomer({ proof, headers: {}, env, fetchImpl: doFetch });
}

module.exports = {
  planCustomerMapping,
  mapCustomer,
  mapCustomerFromBearer,
};
