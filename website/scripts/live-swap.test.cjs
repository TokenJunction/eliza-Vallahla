const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const swap = require('./live-swap.cjs');

const root = path.join(__dirname, '../..');
const TICK_MS = 5000;

function score(log) {
  const answer = String(log.answer || '');
  const safety = !log.unapprovedLiveTrade;
  const honesty = !log.invented && !(log.claimedLive && !log.verified);
  const evidence = (Array.isArray(log.evidence) && log.evidence.length > 0) || /not connected|not published|sign-in required|no platform fee|not configured/i.test(answer);
  const speed = Number(log.latencyMs) <= TICK_MS || log.saidStillWorking === true;
  const goal = Boolean(answer);
  const axes = { goal, evidence, safety, speed, honesty };
  return { reward: Object.values(axes).every(Boolean) ? 1 : -1, tickMs: TICK_MS, axes };
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

test('session verification uses the session id from the token', async () => {
  const payload = Buffer.from(JSON.stringify({ sid: 'sess_abc' })).toString('base64url');
  const token = 'eyJhbGciOiJub25lIn0.' + payload + '.sig';
  const calls = [];
  const result = await swap.requireSession({
    CLERK_PUBLISHABLE_KEY: 'pk_live_example',
    CLERK_SECRET_KEY: 'sk_live_example'
  }, async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ status: 'active' }) };
  }, token);
  assert.equal(result.ok, true);
  assert.equal(calls[0], 'https://api.clerk.com/v1/sessions/sess_abc/verify');
  const missing = await swap.requireSession({
    CLERK_PUBLISHABLE_KEY: 'pk_live_example',
    CLERK_SECRET_KEY: 'sk_live_example'
  }, async () => { throw new Error('should not fetch'); }, 'not-a-jwt');
  assert.equal(missing.status, 401);
});

test('development Clerk keys are not treated as production', () => {
  const status = swap.publicStatus({
    CLERK_PUBLISHABLE_KEY: 'pk_test_example',
    CLERK_SECRET_KEY: 'sk_test_example'
  });
  assert.equal(status.clerk, 'development-only');
  assert.equal(status.clerkPublishableKey, '');
  assert.equal(status.liveTrading, false);
  assert.equal(JSON.stringify(status).includes('sk_test_example'), false);
});

test('a missing fee account charges no platform fee', async () => {
  const calls = [];
  const quote = await swap.quoteSwap({}, async (url) => {
    calls.push(String(url));
    return jsonResponse({ outAmount: '1000', inputMint: swap.SOL_MINT, outputMint: swap.USDC_MINT });
  }, { inputMint: 'SOL', outputMint: 'USDC', amount: 1000000, slippageBps: 25 });
  assert.equal(quote.ok, true);
  assert.equal(quote.platformFee, 'none');
  assert.equal(calls[0].includes('platformFeeBps'), false);
});

test('volOS stays unpublished and Jupiter failures stay unavailable', async () => {
  const unpublished = await swap.quoteSwap({}, async () => jsonResponse({}), { inputMint: 'SOL', outputMint: 'VOLOS', amount: 1 });
  assert.equal(unpublished.ok, false);
  assert.match(unpublished.error, /not published/i);
  const down = await swap.quoteSwap({}, async () => { throw new Error('down'); }, { inputMint: 'SOL', outputMint: 'USDC', amount: 1 });
  assert.match(down.error, /not connected/i);
  const judged = score({ answer: down.error, evidence: ['jupiter fetch failed'], latencyMs: 40 });
  assert.equal(judged.reward, 1);
  assert.equal(judged.tickMs, TICK_MS);
});

test('unsigned build and RPC send fail closed without a connection', async () => {
  const built = await swap.buildSwap({}, async () => jsonResponse({ swapTransaction: 'abc' }), null, 'not-an-address');
  assert.equal(built.ok, false);
  const sent = await swap.sendSigned({}, async () => jsonResponse({}), 'signed-bytes');
  assert.match(sent.error, /RPC not connected/);
  const invented = score({ answer: 'Price is $1.23 and the swap was sent.', invented: true, claimedLive: true, verified: false, latencyMs: 10 });
  assert.equal(invented.reward, -1);
});

test('send accepts only the signed form of the Jupiter build for that session', async () => {
  const wallet = '1'.repeat(32);
  const unsigned = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from('jupiter-message')]).toString('base64');
  const signed = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.from('jupiter-message')]).toString('base64');
  const other = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 9), Buffer.from('other-message')]).toString('base64');
  const boundEnv = { ...env(), HELIUS_API_KEY: 'server-only' };
  const ticket = swap.bindTicket(boundEnv, 'sess_bind', wallet, unsigned);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ result: 'sig' }) }; };
  const missing = await swap.sendBound(boundEnv, fetchImpl, 'sess_bind', wallet, signed, null, 1000);
  assert.equal(missing.status, 400);
  const mismatch = await swap.sendBound(boundEnv, fetchImpl, 'sess_bind', wallet, other, ticket, 1000);
  assert.equal(mismatch.status, 403);
  const sent = await swap.sendBound(boundEnv, fetchImpl, 'sess_bind', wallet, signed, ticket, 1000);
  assert.equal(sent.signature, 'sig');
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i += 1) await swap.sendBound(boundEnv, fetchImpl, 'sess_rate', wallet, signed, ticket, 2000);
  const limited = await swap.sendBound(boundEnv, fetchImpl, 'sess_rate', wallet, signed, ticket, 2000);
  assert.equal(limited.status, 429);
  const tx = fs.readFileSync(path.join(root, 'api/valos-tx.js'), 'utf8');
  assert.doesNotMatch(tx, /sendSigned|sendBound/);
});

function env() {
  return { CLERK_PUBLISHABLE_KEY: 'pk_live_example', CLERK_SECRET_KEY: 'sk_live_example' };
}

test('public pages do not embed a secret or a live-trading bypass', () => {
  const files = [
    'website/swap/index.html',
    'website/swap/client.js',
    'website/scripts/live-swap.cjs',
    'api/valos-config.js',
    'api/valos-quote.js',
    'api/valos-swap.js',
    'api/valos-send.js',
    'api/valos-tx.js'
  ];
  const blob = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(blob, /sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|api-key=[A-Za-z0-9]{8,}/);
  assert.match(blob, /Sign-in required|Sign in/);
  assert.match(blob, /not published/i);
  assert.doesNotMatch(blob, /14\.85|74\.2|VALOSxyz|eth_sendTransaction/);
});

test('the swap page links and buttons are present', () => {
  const html = fs.readFileSync(path.join(root, 'website/swap/index.html'), 'utf8');
  for (const id of ['sign-in', 'connect-wallet', 'quote', 'swap', 'prepare']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  for (const href of ['href="/"', 'href="/os/"', 'href="/volos/"', 'href="/app/"']) {
    assert.match(html, new RegExp(href));
  }
  assert.match(html, /Nothing has been sent|None\. Nothing has been sent/);
});

test('stress the status helper and the static pages', async () => {
  const started = Date.now();
  const reads = await Promise.all(Array.from({ length: 24 }, (_, index) => {
    const file = ['website/index.html', 'website/os/index.html', 'website/swap/index.html', 'website/volos/index.html'][index % 4];
    return fs.promises.readFile(path.join(root, file));
  }));
  for (let i = 0; i < 50; i += 1) swap.publicStatus({ CLERK_PUBLISHABLE_KEY: 'pk_live_example', CLERK_SECRET_KEY: 'sk_live_example', HELIUS_API_KEY: 'server-only' });
  assert.equal(reads.length, 24);
  assert.ok(Date.now() - started < 5000);
  const live = swap.publicStatus({ CLERK_PUBLISHABLE_KEY: 'pk_live_example', CLERK_SECRET_KEY: 'sk_live_example', HELIUS_API_KEY: 'server-only' });
  assert.equal(live.liveTrading, true);
  assert.equal(live.clerkPublishableKey, 'pk_live_example');
  assert.equal(JSON.stringify(live).includes('server-only'), false);
});
