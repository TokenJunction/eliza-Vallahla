const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { handlePush, handleCallback, handleOwnerAction } = require('./push-core.cjs');

const root = path.join(__dirname, '../..');

test('the overseer manifest and service worker are a standalone app', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'website/overseer/manifest.webmanifest'), 'utf8'));
  const worker = fs.readFileSync(path.join(root, 'website/overseer/sw.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'website/overseer/index.html'), 'utf8');
  assert.equal(manifest.name, 'ValhallaOS Overseer');
  assert.equal(manifest.short_name, 'Overseer');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#090a0c');
  assert.equal(manifest.scope, '/overseer/');
  assert.equal(manifest.icons.some(function (icon) { return icon.purpose === 'maskable'; }), true);
  assert.equal(fs.existsSync(path.join(root, 'website/overseer/icon-maskable-512.png')), true);
  assert.match(worker, /addEventListener\('fetch'/);
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /offline\.html/);
  const script = fs.readFileSync(path.join(root, 'website/overseer/overseer.js'), 'utf8');
  assert.match(page, /Continue with Google/);
  assert.match(script, /signInWithOAuth\(\{ provider: 'google'/);
  assert.doesNotMatch(page + script, /signInWithWeb3|wallet connect/i);
  assert.match(page, /Add to Home screen/);
  assert.match(page, /Ship it/);
  assert.match(page, /Undo/);
});

test('push subscribe and unsubscribe stay behind sign-in', async () => {
  const missing = await handlePush({ method: 'POST', headers: {}, body: '{}' }, {
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:ops@example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service'
  }, async () => { throw new Error('no'); });
  assert.equal(missing.status, 401);
  const calls = [];
  const saved = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: JSON.stringify({ action: 'subscribe', subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } })
  }, {
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv-secret',
    VAPID_SUBJECT: 'mailto:ops@example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service'
  }, async (url, init) => {
    calls.push({ url: String(url), method: init && init.method, body: init && init.body });
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    return { ok: true, json: async () => ({}) };
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.body).includes('priv-secret'), false);
  assert.equal(calls.some(function (call) { return call.method === 'POST' && call.body && call.body.includes('user-1'); }), true);
  const removed = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: JSON.stringify({ action: 'unsubscribe', subscription: { endpoint: 'https://push.example/1' } })
  }, {
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv-secret',
    VAPID_SUBJECT: 'mailto:ops@example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service'
  }, async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    assert.equal(init.method, 'DELETE');
    return { ok: true, json: async () => ({}) };
  });
  assert.equal(removed.status, 200);
});

test('the callback hook rejects a bad signature and the owner gate hides actions', async () => {
  const secret = 'hook-secret';
  const body = JSON.stringify({ note: 'Please call back.' });
  const bad = await handleCallback({
    method: 'POST',
    headers: { 'x-callback-signature': '00' },
    body: body
  }, { CALLBACK_HOOK_SECRET: secret }, async () => { throw new Error('no'); });
  assert.equal(bad.status, 401);
  const goodSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const good = await handleCallback({
    method: 'POST',
    headers: { 'x-callback-signature': goodSig },
    body: body
  }, { CALLBACK_HOOK_SECRET: secret }, async () => ({ ok: false, json: async () => ({}) }));
  assert.equal(good.status, 200);
  const stranger = await handleOwnerAction({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: '{"action":"ship"}'
  }, { ADMIN_USER_IDS: 'owner-1' }, async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'other' }) };
    return { ok: false, json: async () => ({}) };
  });
  assert.equal(stranger.status, 404);
});
