const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureProof, measureTamper } = require('./proof-core.cjs');

const root = path.join(__dirname, '../..');

test('a tampered package does not verify', () => {
  const result = measureTamper();
  assert.equal(result.verified, false);
  assert.equal(result.caught, true);
});

test('the proof measurement has the public shape and no secrets', async () => {
  const calls = [];
  const body = await measureProof(async (url) => {
    calls.push(String(url));
    return { status: 200 };
  }, { VERCEL_REGION: 'iad1' }, new Date('2026-11-10T17:00:00Z'));
  assert.equal(body.online, true);
  assert.equal(body.speed, 'Fast');
  assert.equal(body.region, 'iad1');
  assert.match(body.checkedAt, /ET$/);
  assert.equal(body.checks.length, 3);
  assert.deepEqual(body.checks.map(row => row.name), ['Entrance', 'Desk', 'Coin']);
  assert.equal(body.checks.every(row => row.status === 200 && Number.isFinite(row.ms)), true);
  assert.equal(body.delivery.total, 50);
  assert.equal(body.delivery.intact, 50);
  assert.equal(body.delivery.lost, 0);
  assert.equal(Number.isFinite(body.delivery.medianUs), true);
  assert.equal(Number.isFinite(body.delivery.p95Us), true);
  assert.equal(body.tamper.verified, false);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes('BEGIN ') || encoded.includes('wallet'), false);
  assert.equal(calls.includes('https://valhalla-app.xyz/'), true);
  assert.equal(calls.includes('https://valhalla-app.xyz/os/'), true);
  assert.equal(calls.includes('https://valos.live/'), true);
});

test('a hung check times out and the other results still return', async () => {
  const body = await measureProof(async (url) => {
    if (String(url).includes('valos.live')) return new Promise(function () {});
    return { status: 200 };
  }, {}, new Date('2026-11-10T17:00:00Z'), 30);
  assert.equal(body.checks.length, 3);
  assert.equal(body.checks.find(row => row.name === 'Coin').status, 0);
  assert.equal(body.checks.find(row => row.name === 'Entrance').status, 200);
  assert.equal(body.online, false);
  assert.equal(body.delivery.intact, 50);
});

test('the proof page does not load ads', () => {
  const page = fs.readFileSync(path.join(root, 'website/proof/index.html'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const volos = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.doesNotMatch(page, /adsbygoogle|pagead2/);
  assert.match(page, /Delivered intact/);
  assert.match(page, /Try Pro free for 7 days/);
  assert.match(page, /AI models are great at writing instructions/);
  assert.match(home, /See live proof/);
  assert.match(volos, /See live proof/);
});
