'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lib = require('./integrations');

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = original; };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('unconfigured services are reported, not failed', async () => {
  const health = await lib.collectHealth({});
  assert.strictEqual(health.status, 'partial');
  assert.ok(health.checks.every((c) => c.status === 'not_configured'));
  assert.strictEqual(health.safety.trading, 'disabled');
});

test('redis and supabase probes report up and latency', async () => {
  const restore = mockFetch((url) => (url.includes('upstash') ? json(200, { result: 'PONG' }) : json(200, [])));
  try {
    const env = {
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't',
      SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
    };
    const health = await lib.collectHealth(env);
    const by = Object.fromEntries(health.checks.map((c) => [c.name, c]));
    assert.strictEqual(by['upstash-redis'].status, 'up');
    assert.strictEqual(by.supabase.status, 'up');
    assert.strictEqual(by.supabase.privileged, true);
  } finally { restore(); }
});

test('a failing dependency degrades overall status', async () => {
  const restore = mockFetch(() => json(500, { error: 'boom' }));
  try {
    const health = await lib.collectHealth({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' });
    assert.strictEqual(health.status, 'degraded');
  } finally { restore(); }
});

test('rate limiter blocks over the limit and fails open without redis', async () => {
  assert.strictEqual((await lib.rateLimit('a', 1, 60, {})).enforced, false);
  let n = 0;
  const restore = mockFetch(() => json(200, { result: ++n }));
  try {
    const env = { UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' };
    assert.strictEqual((await lib.rateLimit('b', 1, 60, env)).allowed, true);
    assert.strictEqual((await lib.rateLimit('b', 1, 60, env)).allowed, false);
  } finally { restore(); }
});

test('cerberus log always writes a blocked/authorized outcome', async () => {
  let sent;
  const restore = mockFetch((url, opts) => { sent = JSON.parse(opts.body); return json(201, null); });
  try {
    await lib.logCerberusEvent({ action: 'withdraw', outcome: 'weird', reason: 'r' },
      { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    assert.strictEqual(sent.outcome, 'blocked');
  } finally { restore(); }
});
