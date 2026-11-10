const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureProof, measureTamper, handleProof, resetProofLimits } = require('./proof-core.cjs');

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

test('Helius reports the mint, the lock, and swap receipts without full addresses', async () => {
  const unlock = Buffer.alloc(200);
  const cliff = Math.floor(Date.parse('2027-11-08T15:32:42Z') / 1000);
  unlock.writeBigInt64LE(BigInt(cliff), 144);
  unlock.writeBigInt64LE(BigInt(cliff - 86400 * 30), 192);
  const signature = 'jFgUp1TvrvAf6BvJxUVQ3PNiuXYDSekedWyLqgGvHnLVUxNjFuYsBjMX3xXWfbmwGbWjVpa2Gg6cDngDVjaBTa1';
  const body = await measureProof(async (url, init) => {
    const target = String(url);
    if (target.includes('helius-rpc.com')) {
      const request = JSON.parse(init.body);
      if (request.method === 'getAsset') {
        return { ok: true, status: 200, json: async () => ({ result: { token_info: { supply: '1000000000000000', decimals: 6, mint_authority: null, freeze_authority: null } } }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: { value: { data: [unlock.toString('base64'), 'base64'] } } }) };
    }
    if (target.includes('api.helius.xyz')) {
      return { ok: true, status: 200, json: async () => ([{ signature: signature, recommendationSignature: 'recsigrecommendationvalue1234567890abcd', transactionError: null }]) };
    }
    return { status: 200 };
  }, { HELIUS_API_KEY: 'server-key' }, new Date('2026-11-10T17:00:00Z'));
  assert.equal(body.label, 'cryptographic proof');
  assert.equal(body.zk, false);
  assert.equal(body.chain.mint.authoritiesRevoked, true);
  assert.equal(body.chain.mint.supply, '1,000,000,000');
  assert.equal(body.chain.lock.matchesRecord, true);
  assert.equal(body.chain.lock.status, 'Locked');
  assert.equal(body.chain.receipts[0].signature, signature.slice(-4));
  assert.equal(body.chain.receipts[0].status, 'confirmed');
  assert.equal(body.chain.receipts[0].recommendation, 'abcd');
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes('server-key'), false);
  assert.equal(encoded.includes(signature), false);
  assert.equal(encoded.includes('AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump'), false);
});

test('the proof page does not load ads', () => {
  const page = fs.readFileSync(path.join(root, 'website/proof/index.html'), 'utf8');
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const volos = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.doesNotMatch(page, /adsbygoogle|pagead2/);
  assert.match(page, /Delivered intact/);
  assert.match(page, /Try Pro free for 7 days/);
  assert.match(page, /AI models are great at writing instructions/);
  assert.match(page, /Cryptographic proof/);
  assert.match(volos, /Cryptographic proof/);
  assert.match(volos, /Live trading on this page is off/);
  assert.doesNotMatch(volos, /paper desk|Public desk/i);
  assert.match(home, /See live proof/);
  assert.match(volos, /See live proof/);
  const client = fs.readFileSync(path.join(root, 'website/proof/proof.js'), 'utf8');
  assert.doesNotMatch(client, /cache:\s*'no-store'/);
});

test('proof reads are limited and a query does not call Helius', async () => {
  resetProofLimits();
  let calls = 0;
  const measure = async () => {
    calls += 1;
    return { online: true, label: 'cryptographic proof' };
  };
  const denied = await handleProof({ method: 'POST', url: '/api/proof', headers: {} }, {}, null, 1_000, measure);
  assert.equal(denied.status, 405);
  const queried = await handleProof({ method: 'GET', url: '/api/proof?bust=1', headers: {} }, {}, null, 1_000, measure);
  assert.equal(queried.status, 400);
  assert.equal(calls, 0);
  const first = handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.4' } }, {}, null, 1_000, measure);
  const second = handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.5' } }, {}, null, 1_000, measure);
  const pair = await Promise.all([first, second]);
  assert.equal(pair[0].status, 200);
  assert.equal(pair[1].status, 200);
  assert.equal(calls, 1);
  const again = await handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.4' } }, {}, null, 1_000 + 60_000, measure);
  assert.equal(again.status, 200);
  assert.equal(calls, 1);
  let limited = null;
  for (let i = 0; i < 40; i += 1) {
    limited = await handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.9' } }, {}, null, 5_000, measure);
  }
  assert.equal(limited.status, 429);
  assert.equal(calls, 1);
});

test('a failed proof read does not retry on the next request', async () => {
  resetProofLimits();
  let calls = 0;
  const measure = async () => {
    calls += 1;
    throw new Error('down');
  };
  const first = await handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.8' } }, {}, null, 9_000, measure);
  const second = await handleProof({ method: 'GET', url: '/api/proof', headers: { 'x-vercel-forwarded-for': '203.0.113.8' } }, {}, null, 9_000 + 1_000, measure);
  assert.equal(first.status, 503);
  assert.equal(second.status, 503);
  assert.equal(calls, 1);
});
