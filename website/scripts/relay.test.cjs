const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sealPackage, openPackage, sealSnapshot, openSnapshot, handleRelay, handleSnapshot, resetRelay } = require('./relay-core.cjs');

function pair(type) {
  return crypto.generateKeyPairSync(type);
}

test('a tampered, replayed, or wrongly keyed package is refused', () => {
  resetRelay();
  const sender = pair('ed25519');
  const recipient = pair('x25519');
  const other = pair('x25519');
  const seen = new Set();
  const packet = sealPackage({ hello: 'desk' }, {
    from: 'node-a',
    to: 'node-b',
    signPrivate: sender.privateKey,
    agreePublic: recipient.publicKey,
    now: 1_000
  });
  const opened = openPackage(packet, {
    agreePrivate: recipient.privateKey,
    signPublics: { 'node-a': sender.publicKey },
    seen: seen,
    now: 1_000
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.payload.hello, 'desk');
  const replay = openPackage(packet, {
    agreePrivate: recipient.privateKey,
    signPublics: { 'node-a': sender.publicKey },
    seen: seen,
    now: 1_000
  });
  assert.equal(replay.ok, false);
  const tampered = Object.assign({}, packet, { box: packet.box.slice(0, -2) + 'aa' });
  const broken = openPackage(tampered, {
    agreePrivate: recipient.privateKey,
    signPublics: { 'node-a': sender.publicKey },
    seen: new Set(),
    now: 1_000
  });
  assert.equal(broken.ok, false);
  const wrong = openPackage(packet, {
    agreePrivate: other.privateKey,
    signPublics: { 'node-a': sender.publicKey },
    seen: new Set(),
    now: 1_000
  });
  assert.equal(wrong.ok, false);
  assert.equal(JSON.stringify(wrong).includes('BEGIN'), false);
});

test('a backup restores to the same overseer snapshot', async () => {
  const key = crypto.randomBytes(32);
  const doc = { at: '2026-11-10T00:00:00.000Z', health: 'Overseer not connected', config: { site: 'valhalla-app.xyz' } };
  const packed = sealSnapshot(doc, key);
  assert.equal(packed.includes('Overseer not connected'), false);
  assert.deepEqual(openSnapshot(packed, key), doc);
  const env = { BACKUP_ENC_KEY: key.toString('base64'), ADMIN_USER_IDS: 'owner-1', CRON_SECRET: 'cron-secret' };
  const saved = await handleSnapshot({ method: 'GET', headers: { authorization: 'Bearer cron-secret' }, body: '' }, env, async () => { throw new Error('no'); });
  assert.equal(saved.status, 200);
  const restored = await handleSnapshot({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'restore', packed: saved.body.packed })
  }, env, async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    return { ok: false, json: async () => ({}) };
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored.health, 'Overseer not connected');
  const stranger = await handleSnapshot({ method: 'POST', headers: {}, body: '{}' }, env, async () => { throw new Error('no'); });
  assert.equal(stranger.status, 404);
});

test('the relay endpoint rejects a package signed by the wrong key', async () => {
  const sender = pair('ed25519');
  const recipient = pair('x25519');
  const packet = sealPackage({ n: 1 }, {
    from: 'node-a',
    to: 'desk',
    signPrivate: sender.privateKey,
    agreePublic: recipient.publicKey
  });
  packet.box = packet.box.slice(0, -4) + 'xxxx';
  const env = {
    RELAY_AGREE_PRIVATE: recipient.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    RELAY_PEERS: JSON.stringify({ 'node-a': { sign: sender.publicKey.export({ type: 'spki', format: 'pem' }) } })
  };
  const result = await handleRelay({ method: 'POST', headers: {}, body: JSON.stringify(packet) }, env, async () => { throw new Error('no'); });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'The package was refused.');
});
