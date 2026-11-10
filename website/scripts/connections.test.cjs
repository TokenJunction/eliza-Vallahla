const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { encryptSecret, decryptSecret, handleConnections } = require('./connections-core.cjs');

const key = crypto.randomBytes(32).toString('base64');
const env = { CONNECTIONS_ENC_KEY: key };
const secret = 'sk-live-example-key-91';

test('encryption round-trips and does not store the raw key', () => {
  const packed = encryptSecret(secret, Buffer.from(key, 'base64'));
  assert.equal(packed.includes(secret), false);
  assert.equal(decryptSecret(packed, Buffer.from(key, 'base64')), secret);
});

test('signed-out requests are rejected', async () => {
  const result = await handleConnections({ method: 'GET', headers: {} }, env, async () => { throw new Error('no'); });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'Sign-in required.');
});

test('a saved key is not returned, and each user is filtered', async () => {
  const stored = [];
  const result = await handleConnections({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: JSON.stringify({ action: 'save', service: 'openai', key: secret })
  }, env, async (url, init) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    if (target.includes('api.openai.com')) return { ok: true, status: 200, json: async () => ({}) };
    stored.push({ url: target, body: init && init.body });
    const row = JSON.parse(init.body);
    return { ok: true, json: async () => [{ id: 'c1', service: row.service, base_url: row.base_url, last4: row.last4, status: row.status }] };
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.connection.last4, 'y-91');
  assert.equal(JSON.stringify(result.body).includes(secret), false);
  assert.equal(stored[0].body.includes(secret), false);
  assert.match(stored[0].url, /user_id=eq\.user-1|select=id,service/);
  const listed = await handleConnections({
    method: 'GET',
    headers: { authorization: 'Bearer good' }
  }, env, async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-2' }) };
    assert.match(target, /user_id=eq\.user-2/);
    assert.equal(target.includes('ciphertext'), false);
    assert.equal(target.includes('key_hash'), false);
    return { ok: true, json: async () => [] };
  });
  assert.equal(listed.status, 200);
  assert.equal(JSON.stringify(listed.body).includes(secret), false);
});

test('row policies keep each user on their own rows', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261110140000_connections.sql'), 'utf8');
  assert.match(sql, /auth\.uid\(\) = user_id/);
  assert.match(sql, /revoke all on public\.connections from authenticated/);
  assert.doesNotMatch(sql, /grant select \(id, user_id, service, base_url, last4, ciphertext/);
});
