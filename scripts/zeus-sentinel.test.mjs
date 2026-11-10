import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scanSecrets,
  reviewFile,
  reviewComment,
  lastRollbackAt,
  rollbackDecision,
  freeModelsFrom,
  checkUrl,
  promoteUrl,
  recordRollback,
  run,
  CHECKS
} from './zeus-sentinel.mjs';

const SIX_HOURS = 6 * 60 * 60 * 1000;

test('the secret scanner flags key material and ignores ordinary prose', () => {
  assert.deepEqual(scanSecrets('the desk is paper-first').length, 0);
  assert.ok(scanSecrets('sk_live_abc123').includes('sk_ pattern'));
  assert.ok(scanSecrets('sb_secret_example').includes('sb_secret_ pattern'));
  assert.ok(scanSecrets('hf_tokenvalue').includes('hf_ pattern'));
  assert.ok(scanSecrets('-----BEGIN PRIVATE KEY-----').includes('private key'));
  assert.ok(scanSecrets('Authorization: Bearer abcdefghijklmnop').includes('bearer token'));
});

test('a diff review flags 3DES, DNS, wallet, trading, and public server keys', () => {
  assert.deepEqual(reviewFile({ filename: 'notes.md', patch: '+\n+plain copy\n' }), []);
  assert.equal(reviewFile({ filename: 'crypto.js', patch: '+use 3DES\n' })[0].reason, '3DES');
  assert.equal(reviewFile({ filename: 'dns.js', patch: '+add an A-record\n' })[0].reason, 'DNS or A-record');
  assert.equal(reviewFile({ filename: 'desk.js', patch: '+wallet connect\n' })[0].reason, 'wallet or trading change');
  assert.equal(reviewFile({ filename: 'trade.js', patch: '+live trading stays off\n' })[0].reason, 'wallet or trading change');
  const publicHit = reviewFile({ filename: 'website/os/ai.js', patch: '+const key = process.env.OPENROUTER_API_KEY\n' });
  assert.ok(publicHit.some(function (flag) { return flag.reason === 'server key referenced in a public file'; }));
  const htmlHit = reviewFile({ filename: 'website/index.html', patch: '+hf_examplekey\n' });
  assert.ok(htmlHit.some(function (flag) { return flag.reason === 'server key referenced in a public file'; }));
  assert.match(reviewComment([]), /^Zeus pre-review: PASS/);
  assert.match(reviewComment([{ path: 'a.js', reason: '3DES' }]), /^Zeus pre-review: FLAG/);
});

test('rollback waits six hours and never runs without a token or a verified deployment', () => {
  const now = Date.parse('2026-11-10T18:00:00Z');
  assert.equal(rollbackDecision({ siteDown: false, hasToken: true, deploymentId: 'dpl_1', historyKnown: true, now: now }).action, 'skip');
  assert.equal(rollbackDecision({ siteDown: true, hasToken: false, deploymentId: 'dpl_1', historyKnown: true, now: now }).reason, 'VERCEL_TOKEN is not set');
  assert.equal(rollbackDecision({ siteDown: true, hasToken: true, deploymentId: '', historyKnown: true, now: now }).reason, 'ZEUS_LAST_VERIFIED_DEPLOYMENT is not set');
  assert.equal(rollbackDecision({ siteDown: true, hasToken: true, deploymentId: 'dpl_1', historyKnown: false, now: now }).reason, 'rollback history could not be read');
  assert.equal(rollbackDecision({ siteDown: true, hasToken: true, deploymentId: 'dpl_1', historyKnown: true, lastRollbackAt: now - SIX_HOURS + 1, now: now }).reason, 'a rollback already happened in the last 6 hours');
  assert.equal(rollbackDecision({ siteDown: true, hasToken: true, deploymentId: 'dpl_1', historyKnown: true, alreadyRolledBack: true, now: now }).reason, 'this run already rolled back once');
  const ready = rollbackDecision({ siteDown: true, hasToken: true, deploymentId: 'dpl_1', historyKnown: true, lastRollbackAt: now - SIX_HOURS, now: now });
  assert.equal(ready.action, 'rollback');
  assert.equal(lastRollbackAt([{ body: 'note' }, { body: 'rollback-at: 2026-11-10T12:00:00Z' }]), Date.parse('2026-11-10T12:00:00Z'));
  assert.equal(lastRollbackAt({ message: 'Issues are disabled' }), null);
  assert.match(promoteUrl('dpl_1'), /\/v10\/projects\/eliza-valhalla\/promote\/dpl_1\?teamId=team_AsAJ3GVmfx8BxRUIQdEcZrgv$/);
});

test('a failed check is retried twice and a signed-out 401 is success', async () => {
  let calls = 0;
  const sleeps = [];
  const recovered = await checkUrl(CHECKS[0], {
    gapMs: 30_000,
    sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
    fetchImpl: async function () {
      calls += 1;
      return { status: calls < 3 ? 500 : 200 };
    }
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempts, 3);
  assert.deepEqual(sleeps, [30_000, 30_000]);
  const signedOut = await checkUrl(CHECKS[4], {
    gapMs: 0,
    sleep: async function () {},
    fetchImpl: async function () { return { status: 401 }; }
  });
  assert.equal(signedOut.ok, true);
  const methodRejected = await checkUrl(CHECKS[4], {
    gapMs: 0,
    sleep: async function () {},
    fetchImpl: async function () { return { status: 405 }; }
  });
  assert.equal(methodRejected.ok, true);
  const hung = await checkUrl(CHECKS[0], {
    attempts: 1,
    gapMs: 0,
    timeoutMs: 20,
    sleep: async function () {},
    fetchImpl: function (_url, init) {
      return new Promise(function (_resolve, reject) {
        init.signal.addEventListener('abort', function () { reject(new Error('aborted')); });
      });
    }
  });
  assert.equal(hung.ok, false);
  const down = await checkUrl(CHECKS[5], {
    gapMs: 0,
    sleep: async function () {},
    fetchImpl: async function () { return { status: 503 }; }
  });
  assert.equal(down.ok, false);
});

test('the allowlist reader keeps only :free model ids', () => {
  const source = readFileSync(new URL('../website/scripts/ai-core.cjs', import.meta.url), 'utf8');
  const models = freeModelsFrom(source);
  assert.deepEqual(models, ['nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-31b-it:free']);
});

test('a rejected promote does not start the cooldown', async () => {
  let noted = 0;
  const result = await run({
    VERCEL_TOKEN: 'token',
    ZEUS_LAST_VERIFIED_DEPLOYMENT: 'dpl_old'
  }, {
    gapMs: 0,
    timeoutMs: 1000,
    now: Date.parse('2026-11-10T18:00:00Z'),
    fetchImpl: async function (url) {
      if (String(url).includes('/promote/')) return { ok: false, status: 403 };
      return { status: 500 };
    },
    readRollbackHistory: async function () { return { known: true, at: null }; },
    recordRollback: async function () { noted += 1; },
    probeModels: async function () { return []; },
    reviewPulls: async function () { return []; },
    publishReport: async function () {}
  });
  assert.equal(noted, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.rollback, /promote failed status 403/);
});

test('the first rollback writes a cooldown comment when no status issue exists', async () => {
  const calls = [];
  const issue = await recordRollback({
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'TokenJunction/eliza-valhalla'
  }, async function (url, init) {
    calls.push(String(url) + ' ' + (init && init.method));
    if (init && init.method === 'POST' && String(url).endsWith('/issues')) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ number: 9 }) };
    }
    return { ok: true, status: 201, text: async () => '{}' };
  }, null, '2026-11-10T18:00:00.000Z');
  assert.equal(issue.number, 9);
  assert.ok(calls.some(function (call) { return call.includes('/issues/9/comments POST'); }));
});

test('the workflow and the doc refuse merge, main, and a new deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/zeus-sentinel.yml', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../docs/zeus-sentinel.md', import.meta.url), 'utf8');
  const script = readFileSync(new URL('./zeus-sentinel.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /cron:\s*['"]0 \*\/3 \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*branches:\s*\[main\]|git push|vercel deploy/i);
  assert.match(doc, /never merge/i);
  assert.match(doc, /OPENROUTER_API_KEY/);
  assert.match(doc, /VERCEL_TOKEN/);
  assert.match(doc, /ZEUS_LAST_VERIFIED_DEPLOYMENT/);
  assert.doesNotMatch(script, /sk_live_|gh_pat_|BEGIN PRIVATE KEY/);
  assert.doesNotMatch(script, /\/merge|APPROVE/);
});
