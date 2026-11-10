const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleAdmin, handlePush, previousReady, looksSecret } = require('./admin-core.cjs');

const env = {
  ADMIN_USER_IDS: 'owner-1',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  GITHUB_PUSH_TOKEN: 'github-token-test',
  VERCEL_TOKEN: 'vercel-token-test',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_ORG_ID: 'team_test'
};

function authed(id) {
  return async function (url) {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: id }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

test('the desk shell opens owner controls as windows', () => {
  const html = fs.readFileSync(path.join(__dirname, '../os/index.html'), 'utf8');
  assert.match(html, /data-window="admin"/);
  assert.match(html, /data-window="overseer"/);
  assert.match(html, /data-window="proof"/);
  assert.match(html, /data-window="trial"/);
  assert.match(html, /id="admin-icon"[^>]*hidden/);
  assert.match(html, /id="overseer-icon"[^>]*hidden/);
  assert.match(html, /data-open="proof"/);
  assert.match(html, /data-open="trial"/);
  assert.match(html, />Undo</);
});

test('sign-out clears the admin cookie', async () => {
  const left = await handleAdmin({ method: 'POST', headers: {}, body: '{"action":"leave"}' }, env, async () => { throw new Error('no'); });
  assert.equal(left.status, 200);
  assert.match(left.headers['set-cookie'], /Max-Age=0/);
});

test('a staged svg preview cannot run as a page', async () => {
  const result = await handleAdmin({
    method: 'GET',
    headers: { authorization: 'Bearer owner' },
    url: '/api/admin?preview=website/mark.svg'
  }, env, async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    return { ok: true, arrayBuffer: async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') };
  });
  assert.equal(result.status, 200);
  assert.equal(result.type, 'application/octet-stream');
  assert.match(result.headers['content-disposition'], /attachment/);
  assert.match(result.headers['content-security-policy'], /sandbox/);
  const page = fs.readFileSync(path.join(__dirname, '../admin/board.js'), 'utf8');
  assert.doesNotMatch(page, /svg\)\$/);
});

test('everyone except the allowlisted owner gets 404', async () => {
  const outsider = await handleAdmin({ method: 'GET', headers: { authorization: 'Bearer person' } }, env, authed('person-2'));
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error, 'Not found.');
  assert.equal(JSON.stringify(outsider).includes('owner-1'), false);
  const missing = await handlePush({ method: 'POST', headers: {}, body: '{"action":"list"}' }, env, async () => { throw new Error('no'); });
  assert.equal(missing.status, 404);
});

test('secret paths and secret contents are refused', async () => {
  assert.equal(looksSecret('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(looksSecret('whsec_testsecretvalue'), true);
  assert.equal(looksSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig'), true);
  assert.equal(looksSecret('sk_live_12345678'), true);
  assert.equal(looksSecret('rk_live_12345678'), true);
  const calls = [];
  const result = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'scan', path: 'website/page.js' })
  }, env, async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    if (init && init.method === 'DELETE') return { ok: true, json: async () => ({}) };
    return { ok: true, arrayBuffer: async () => Buffer.from('-----BEGIN PRIVATE KEY-----\nsecret\n') };
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'That file was refused.');
  assert.equal(JSON.stringify(result.body).includes('PRIVATE KEY'), false);
  assert.equal(calls.some(function (call) { return call.method === 'DELETE'; }), true);
  const envFile = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'sign', path: 'website/.env', bytes: 20 })
  }, env, authed('owner-1'));
  assert.equal(envFile.status, 400);
  const outside = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'sign', path: 'notes/readme.md', bytes: 20 })
  }, env, authed('owner-1'));
  assert.equal(outside.status, 400);
  const script = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'sign', path: 'website/scripts/admin-core.cjs', bytes: 20 })
  }, env, authed('owner-1'));
  assert.equal(script.status, 400);
});

test('publish opens a branch and a pull request', async () => {
  const calls = [];
  const result = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'publish' })
  }, env, async (url, init) => {
    const target = String(url);
    calls.push({ url: target, body: init && init.body });
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    if (target.includes('/admin_uploads')) return { ok: true, json: async () => ([{ path: 'website/page.js', bytes: 5, content_type: 'text/javascript' }]) };
    if (target.includes('/storage/v1/object/')) return { ok: true, arrayBuffer: async () => Buffer.from('body{}') };
    if (target.endsWith('/git/ref/heads/develop')) return { ok: true, json: async () => ({ object: { sha: 'parent' } }) };
    if (target.endsWith('/git/commits/parent')) return { ok: true, json: async () => ({ tree: { sha: 'tree' } }) };
    if (target.endsWith('/git/blobs')) return { ok: true, json: async () => ({ sha: 'blob' }) };
    if (target.endsWith('/git/trees')) return { ok: true, json: async () => ({ sha: 'next-tree' }) };
    if (target.endsWith('/git/commits')) return { ok: true, json: async () => ({ sha: 'commit' }) };
    if (target.endsWith('/git/refs')) return { ok: true, json: async () => ({ ref: 'refs/heads/owner/push-5' }) };
    if (target.endsWith('/pulls')) return { ok: true, json: async () => ({ number: 80, html_url: 'https://example.com/pull/80' }) };
    return { ok: false, json: async () => ({}) };
  }, 5);
  assert.equal(result.status, 200);
  assert.equal(result.body.branch, 'owner/push-5');
  assert.equal(result.body.number, 80);
  const ref = calls.find(function (call) { return call.url.endsWith('/git/refs'); });
  const pull = calls.find(function (call) { return call.url.endsWith('/pulls'); });
  assert.match(ref.body, /refs\/heads\/owner\/push-5/);
  assert.match(pull.body, /"base":"develop"/);
  assert.equal(JSON.stringify(result.body).includes('github-token-test'), false);
});

test('ship waits until checks pass', async () => {
  let merged = false;
  const blocked = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'ship', number: 80 })
  }, env, async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    if (target.endsWith('/pulls/80')) return { ok: true, json: async () => ({ base: { ref: 'develop' }, head: { ref: 'owner/push-5', sha: 'abc' } }) };
    if (target.includes('/check-runs')) return { ok: true, json: async () => ({ check_runs: [{ status: 'in_progress', conclusion: null }] }) };
    merged = true;
    return { ok: true, json: async () => ({}) };
  });
  assert.equal(blocked.status, 409);
  assert.equal(merged, false);
  const unread = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'ship', number: 80 })
  }, env, async (url, init) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    if (target.endsWith('/pulls/80')) return { ok: true, json: async () => ({ base: { ref: 'develop' }, head: { ref: 'owner/push-5', sha: 'abc' } }) };
    if (target.includes('/check-runs')) return { ok: false, status: 403, json: async () => ({}) };
    assert.equal(init && init.method, 'PUT');
    return { ok: true, json: async () => ({}) };
  });
  assert.equal(unread.status, 200);
});

test('rollback selects the previous READY deployment', async () => {
  const ready = [{ uid: 'dpl_current', readyState: 'READY' }, { uid: 'dpl_old', state: 'ERROR' }, { uid: 'dpl_previous', readyState: 'READY' }];
  assert.equal(previousReady(ready).uid, 'dpl_previous');
  let rollbackUrl = '';
  const result = await handlePush({
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
    body: JSON.stringify({ action: 'rollback' })
  }, env, async (url, init) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner-1' }) };
    if (target.includes('/v6/deployments')) return { ok: true, json: async () => ({ deployments: ready }) };
    rollbackUrl = target;
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => ({}) };
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.deployment, 'dpl_previous');
  assert.match(rollbackUrl, /\/rollback\/dpl_previous/);
  assert.equal(rollbackUrl.includes('dpl_current'), false);
});
