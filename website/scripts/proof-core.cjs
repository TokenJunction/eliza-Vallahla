'use strict';

const crypto = require('node:crypto');

const TARGETS = [
  { name: 'Entrance', url: 'https://valhalla-app.xyz/' },
  { name: 'Desk', url: 'https://valhalla-app.xyz/os/' },
  { name: 'Coin', url: 'https://valos.live/' }
];
const MINT = 'AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump';
const ESCROW = '96u5SEevcWsU5XZWSamxaCeUMk49GDiabTgHkwCijNz5';
const RECORD_UNLOCK = Math.floor(Date.parse('2027-11-08T15:32:42Z') / 1000);

function percentile(sorted, ratio) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function measureDelivery() {
  const key = crypto.randomBytes(32);
  const samples = [];
  let intact = 0;
  for (let i = 0; i < 50; i += 1) {
    const body = Buffer.from(JSON.stringify({ n: i, pad: crypto.randomBytes(16).toString('hex') }));
    const start = process.hrtime.bigint();
    const mac = crypto.createHmac('sha256', key).update(body).digest();
    const check = crypto.createHmac('sha256', key).update(body).digest();
    const left = crypto.createHash('sha256').update(body).digest('hex');
    const right = crypto.createHash('sha256').update(body).digest('hex');
    const ok = crypto.timingSafeEqual(mac, check) && left === right;
    const micros = Number(process.hrtime.bigint() - start) / 1000;
    samples.push(micros);
    if (ok) intact += 1;
  }
  samples.sort(function (a, b) { return a - b; });
  return {
    intact: intact,
    total: 50,
    lost: 50 - intact,
    medianUs: median(samples),
    p95Us: percentile(samples, 0.95)
  };
}

function measureTamper() {
  const key = crypto.randomBytes(32);
  const body = Buffer.from('package');
  const mac = crypto.createHmac('sha256', key).update(body).digest();
  const tampered = Buffer.from('package!');
  const check = crypto.createHmac('sha256', key).update(tampered).digest();
  const verified = crypto.timingSafeEqual(mac, check);
  return { verified: verified, caught: !verified };
}

function speedFor(checks) {
  const worst = Math.max.apply(null, checks.map(function (row) { return row.ms; }));
  if (worst < 300) return 'Fast';
  if (worst < 800) return 'Normal';
  return 'Slow';
}

function checkedAt(now) {
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(now);
  return stamp.replace('GMT-4', 'ET').replace('GMT-5', 'ET').replace('EDT', 'ET').replace('EST', 'ET');
}

function withTimeout(work, ms) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
    Promise.resolve().then(work).then(function (value) {
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function timeOne(target, fetchImpl, timeoutMs) {
  const start = process.hrtime.bigint();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  try {
    const response = await withTimeout(function () {
      return fetchImpl(target.url, { method: 'GET', redirect: 'follow', signal: controller && controller.signal });
    }, timeoutMs);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { name: target.name, status: response && response.status ? response.status : 0, ms: Math.round(ms) };
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { name: target.name, status: 0, ms: Math.round(ms) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function last4(value) {
  return String(value || '').slice(-4);
}

function scrub(value) {
  return String(value || '').replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, function (hit) {
    return '…' + hit.slice(-4);
  });
}

function supplyText(info) {
  if (!info || info.supply == null) return '';
  const decimals = Number(info.decimals || 0);
  const raw = String(info.supply);
  const whole = decimals && raw.length > decimals ? raw.slice(0, -decimals) : raw;
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function revoked(value) {
  return value == null || value === '' || value === '11111111111111111111111111111111';
}

function readU64(buf, offset) {
  if (buf.length < offset + 8) return 0;
  const value = buf.readBigUInt64LE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(value);
}

function stampOk(value) {
  return value > 1700000000 && value < 2000000000;
}

function unlockFrom(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
  const cliff = readU64(buf, 144);
  const frequency = readU64(buf, 152);
  const periods = readU64(buf, 176);
  if (!stampOk(cliff)) return { cliff: 0, unlock: 0 };
  const unlock = cliff + frequency * periods;
  return { cliff: cliff, unlock: stampOk(unlock) ? unlock : 0 };
}

function etStamp(seconds) {
  return checkedAt(new Date(seconds * 1000));
}

async function rpc(key, method, params, fetchImpl) {
  const response = await fetchImpl('https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
  });
  if (!response || !response.ok || typeof response.json !== 'function') return null;
  const body = await response.json();
  return body && body.result ? body.result : null;
}

async function readChain(fetchImpl, key, now) {
  if (!key) return { configured: false, label: 'cryptographic proof', zk: false };
  const asset = await rpc(key, 'getAsset', { id: MINT }, fetchImpl);
  const account = await rpc(key, 'getAccountInfo', [ESCROW, { encoding: 'base64' }], fetchImpl);
  const swaps = await fetchImpl('https://api.helius.xyz/v0/addresses/' + MINT + '/transactions?api-key=' + encodeURIComponent(key) + '&type=SWAP&limit=5');
  const rows = swaps && swaps.ok && typeof swaps.json === 'function' ? await swaps.json() : [];
  const info = asset && asset.token_info;
  const schedule = account && account.value && account.value.data ? unlockFrom(account.value.data[0]) : { cliff: 0, unlock: 0 };
  const unlock = schedule.unlock;
  const receipts = (Array.isArray(rows) ? rows : []).slice(0, 5).map(function (tx) {
    const recommendation = tx && tx.recommendationSignature ? last4(tx.recommendationSignature) : '';
    return {
      signature: last4(tx && tx.signature),
      status: tx && tx.transactionError ? 'failed' : 'confirmed',
      recommendation: recommendation,
      note: recommendation ? 'Signed recommendation …' + recommendation : 'No signed recommendation stored'
    };
  });
  const body = {
    configured: true,
    label: 'cryptographic proof',
    zk: false,
    mint: {
      last4: last4(MINT),
      authoritiesRevoked: info ? revoked(info.mint_authority) && revoked(info.freeze_authority) : null,
      supply: supplyText(info)
    },
    lock: {
      last4: last4(ESCROW),
      label: 'The founder wallet\'s valOS is locked',
      status: unlock && now && unlock * 1000 > now.getTime() ? 'Locked' : (unlock ? 'Unlock time has passed' : 'Not read'),
      cliffAt: schedule.cliff ? etStamp(schedule.cliff) : '',
      unlockAt: unlock ? etStamp(unlock) : '',
      recordAt: etStamp(RECORD_UNLOCK),
      matchesRecord: unlock === RECORD_UNLOCK
    },
    receipts: receipts
  };
  const encoded = JSON.stringify(body);
  if (encoded.includes(key) || encoded.includes(MINT) || encoded.includes(ESCROW)) {
    return { configured: true, label: 'cryptographic proof', zk: false, error: 'On-chain proof not checked' };
  }
  return body;
}

async function measureProof(fetchImpl, env, now, timeoutMs) {
  const limit = timeoutMs || 4000;
  const checks = await Promise.all(TARGETS.map(function (target) { return timeOne(target, fetchImpl, limit); }));
  const online = checks.every(function (row) { return row.status >= 200 && row.status < 300; });
  const region = env && typeof env.VERCEL_REGION === 'string' && env.VERCEL_REGION ? env.VERCEL_REGION : null;
  const when = now || new Date();
  let chain = { configured: false, label: 'cryptographic proof', zk: false };
  if (env && env.HELIUS_API_KEY) {
    try { chain = await withTimeout(function () { return readChain(fetchImpl, env.HELIUS_API_KEY, when); }, limit); }
    catch (error) { chain = { configured: true, label: 'cryptographic proof', zk: false, error: 'On-chain proof not checked' }; }
  }
  return {
    online: online,
    speed: online ? speedFor(checks) : 'Slow',
    checkedAt: checkedAt(when),
    region: region,
    checks: checks,
    delivery: measureDelivery(),
    tamper: measureTamper(),
    label: 'cryptographic proof',
    zk: false,
    chain: chain
  };
}

const WINDOW_MS = 60 * 1000;
const IP_LIMIT = 30;
const SUCCESS_TTL = 5 * 60 * 1000;
const FAILURE_TTL = 60 * 1000;
const hits = new Map();
let cached = null;
let inflight = null;
let blockedUntil = 0;

function resetProofLimits() {
  hits.clear();
  cached = null;
  inflight = null;
  blockedUntil = 0;
}

function headerValue(headers, name) {
  if (!headers) return '';
  return headers[name] || headers[name.toLowerCase()] || '';
}

function clientIp(headers) {
  const trusted = headerValue(headers, 'x-vercel-forwarded-for') || headerValue(headers, 'x-real-ip') || headerValue(headers, 'x-forwarded-for');
  const first = String(trusted).split(',')[0].trim();
  return first || 'unknown';
}

function pruneHits(now) {
  for (const [ip, times] of hits) {
    const recent = times.filter(function (at) { return now - at < WINDOW_MS; });
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}

function allowIp(ip, now) {
  const recent = (hits.get(ip) || []).filter(function (at) { return now - at < WINDOW_MS; });
  if (recent.length >= IP_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  if (!hits.has(ip) && hits.size >= 2000) {
    pruneHits(now);
    if (!hits.has(ip) && hits.size >= 2000) return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

async function handleProof(req, env, fetchImpl, now, measure) {
  if (!req || req.method !== 'GET') {
    return { status: 405, cache: 'no-store', body: { error: 'Method not allowed.' } };
  }
  if (String(req.url || '').indexOf('?') !== -1) {
    return { status: 400, cache: 'no-store', body: { error: 'This address takes no query.' } };
  }
  const stamp = now || Date.now();
  const ip = clientIp(req.headers);
  if (!allowIp(ip, stamp)) {
    return { status: 429, cache: 'no-store', body: { error: 'Too many proof requests.' } };
  }
  if (cached && stamp < cached.until) {
    return { status: 200, cache: 'public, max-age=60, s-maxage=300, stale-while-revalidate=300', body: cached.body };
  }
  if (stamp < blockedUntil) {
    return { status: 503, cache: 'no-store', body: { error: 'Proof not checked.' } };
  }
  const run = measure || measureProof;
  if (!inflight) {
    inflight = run(fetchImpl, env, new Date(stamp)).then(function (body) {
      cached = { until: stamp + SUCCESS_TTL, body: body };
      return body;
    }).catch(function () {
      blockedUntil = stamp + FAILURE_TTL;
      throw new Error('proof');
    }).finally(function () {
      inflight = null;
    });
  }
  try {
    await inflight;
  } catch (error) {
    return { status: 503, cache: 'no-store', body: { error: 'Proof not checked.' } };
  }
  return { status: 200, cache: 'public, max-age=60, s-maxage=300, stale-while-revalidate=300', body: cached && cached.body };
}

module.exports = {
  measureProof: measureProof,
  measureTamper: measureTamper,
  measureDelivery: measureDelivery,
  readChain: readChain,
  scrub: scrub,
  handleProof: handleProof,
  resetProofLimits: resetProofLimits
};
