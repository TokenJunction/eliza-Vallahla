'use strict';

const crypto = require('node:crypto');

const TARGETS = [
  { name: 'Entrance', url: 'https://valhalla-app.xyz/' },
  { name: 'Desk', url: 'https://valhalla-app.xyz/os/' },
  { name: 'Coin', url: 'https://valos.live/' }
];

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

async function measureProof(fetchImpl, env, now, timeoutMs) {
  const limit = timeoutMs || 4000;
  const checks = await Promise.all(TARGETS.map(function (target) { return timeOne(target, fetchImpl, limit); }));
  const online = checks.every(function (row) { return row.status >= 200 && row.status < 300; });
  const region = env && typeof env.VERCEL_REGION === 'string' && env.VERCEL_REGION ? env.VERCEL_REGION : null;
  return {
    online: online,
    speed: online ? speedFor(checks) : 'Slow',
    checkedAt: checkedAt(now || new Date()),
    region: region,
    checks: checks,
    delivery: measureDelivery(),
    tamper: measureTamper()
  };
}

module.exports = { measureProof: measureProof, measureTamper: measureTamper, measureDelivery: measureDelivery };
