'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mapCustomer, mapCustomerFromBearer, planCustomerMapping } = require('./customer-identity');

const hash = 'a'.repeat(64);
const customerId = '11111111-1111-4111-8111-111111111111';

function proof(extra) {
  return Object.assign({
    ok: true,
    subject: hash,
    sessionId: '22222222-2222-4222-8222-222222222222',
    code: true,
    google: false,
    leader: false,
    role: 'admin',
  }, extra || {});
}

test('a customer mapping ignores client email and does not become an admin grant', () => {
  const plan = planCustomerMapping(proof());
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.role, 'customer');
  assert.strictEqual(plan.adminSecrets, false);
  assert.strictEqual(plan.leader, false);
  assert.strictEqual(plan.supabaseAuthUid, null);
  assert.strictEqual(plan.tenant, 'valhalla');
  assert.strictEqual(planCustomerMapping(proof({ email: 'ada@example.test' })).error, 'copied-identity-rejected');
  assert.strictEqual(planCustomerMapping(proof({ uid: customerId })).error, 'copied-identity-rejected');
  assert.strictEqual(planCustomerMapping(proof({ code: false })).error, 'proof-required');
  assert.strictEqual(planCustomerMapping(proof({ code: false, google: true })).leader, false);

  const leader = planCustomerMapping(proof({ google: true, leader: true }));
  assert.strictEqual(leader.leader, true);
  assert.strictEqual(leader.role, 'customer');
  assert.strictEqual(leader.adminSecrets, false);
  assert.strictEqual(planCustomerMapping(proof({ code: false, google: false })).ok, false);
});

test('mapping rejects identity headers and an anon key', async () => {
  const headers = { 'x-user-id': customerId, email: 'ada@example.test' };
  assert.strictEqual((await mapCustomer({ proof: proof(), headers, env: {} })).error, 'header-identity-rejected');
  const anon = await mapCustomer({
    proof: proof(),
    env: { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'anon' },
  });
  assert.strictEqual(anon.error, 'service-role-required');
});

test('the backend stores only the email hash and keeps the service role off the auth request', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/access')) {
      return { ok: true, json: async () => proof({ google: true, leader: true }) };
    }
    if (options.method === 'GET') return { ok: true, text: async () => '[]' };
    return { ok: true, text: async () => JSON.stringify([{ customer_id: customerId, email_hash: hash, tenant: 'valhalla' }]) };
  };
  const mapped = await mapCustomerFromBearer({
    authBase: 'https://auth.example',
    bearer: 'live-session-token',
    headers: { 'x-email': 'ada@example.test' },
    env: {
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
      LEADER_EMAIL: 'leader@example.test',
      DEVICE_COOKIE_SECRET: 'signing-secret',
    },
    fetchImpl,
  });
  assert.strictEqual(mapped.error, 'header-identity-rejected');

  const accepted = await mapCustomerFromBearer({
    authBase: 'https://auth.example',
    bearer: 'live-session-token',
    env: {
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
      LEADER_EMAIL: 'leader@example.test',
    },
    fetchImpl,
  });
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.memberId, customerId);
  assert.strictEqual(accepted.customerId, customerId);
  assert.strictEqual(accepted.tenant, 'valhalla');
  assert.strictEqual(Object.hasOwn(accepted, 'emailHash'), false);
  assert.strictEqual(accepted.role, 'customer');
  assert.strictEqual(accepted.leader, true);
  assert.strictEqual(accepted.adminSecrets, false);
  assert.strictEqual(JSON.stringify(accepted).includes('service-role-secret'), false);
  assert.strictEqual(JSON.stringify(accepted).includes('leader@example.test'), false);

  const authCall = calls.find((call) => call.url.includes('/auth/access'));
  const insert = calls.find((call) => call.options && call.options.method === 'POST');
  assert.strictEqual(authCall.options.headers.authorization, 'Bearer live-session-token');
  assert.strictEqual(JSON.stringify(authCall.options.headers).includes('service-role-secret'), false);
  assert.deepStrictEqual(JSON.parse(insert.options.body), { email_hash: hash, tenant: 'valhalla' });
  assert.strictEqual(insert.options.headers.Authorization, 'Bearer service-role-secret');
});
