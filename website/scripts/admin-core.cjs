'use strict';

const { publicSupabase } = require('./feed-core.cjs');

const MAX_BYTES = 5 * 1024 * 1024;
const CHECK_GAP_MS = 10 * 60 * 1000;
const REPO = 'TokenJunction/eliza-valhalla';

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/,
  /\brk_[A-Za-z0-9_]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  /\bsb_secret_[A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
  /\bpk_(live|test)_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/
];

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function cookieToken(headers) {
  const raw = headers && (headers.cookie || headers.Cookie) || '';
  const match = String(raw).match(/(?:^|;\s*)valos_admin=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function allowlist(env) {
  return String(env && env.ADMIN_USER_IDS || '').split(',').map(function (item) {
    return item.trim();
  }).filter(Boolean);
}

function notFound() {
  return { status: 404, body: { error: 'Not found.' } };
}

function cleanPath(input) {
  const path = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.includes('..') || path.includes('\0')) return '';
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  if (parts.some(function (part) { return !part || part.startsWith('.') || part === 'secret' || part.includes('credential') || part.includes('.pem') || part.includes('id_rsa'); })) return '';
  if (lower.includes('.env')) return '';
  if (lower === 'website/scripts' || lower.startsWith('website/scripts/')) return '';
  if (!(lower.startsWith('website/') || lower.startsWith('assets/'))) return '';
  return path;
}

function looksSecret(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  return SECRET_PATTERNS.some(function (pattern) { return pattern.test(text); });
}

async function verifyUser(token, fetchImpl) {
  const site = publicSupabase();
  if (!site.url || !site.key || !token) return null;
  const response = await fetchImpl(site.url + '/auth/v1/user', {
    headers: { authorization: 'Bearer ' + token, apikey: site.key }
  });
  if (!response || !response.ok) return null;
  const user = await response.json();
  return user && typeof user.id === 'string' && user.id ? user : null;
}

async function adminUser(req, env, fetchImpl) {
  const token = bearer(req.headers) || cookieToken(req.headers);
  if (!token) return null;
  let user;
  try { user = await verifyUser(token, fetchImpl); }
  catch (error) { return null; }
  if (!user || allowlist(env).indexOf(user.id) === -1) return null;
  return user;
}

function serviceHeaders(env) {
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  return {
    authorization: 'Bearer ' + key,
    apikey: key,
    'content-type': 'application/json'
  };
}

function githubHeaders(env) {
  return {
    authorization: 'Bearer ' + String(env.GITHUB_PUSH_TOKEN || ''),
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'valos-admin',
    'content-type': 'application/json'
  };
}

function vercelProject(env) {
  return {
    project: String(env.VERCEL_PROJECT_ID || ''),
    team: String(env.VERCEL_ORG_ID || env.VERCEL_TEAM_ID || ''),
    token: String(env.VERCEL_TOKEN || '')
  };
}

function previousReady(deployments) {
  const ready = (deployments || []).filter(function (item) {
    return item && (item.readyState === 'READY' || item.state === 'READY') && item.uid;
  });
  return ready.length >= 2 ? ready[1] : null;
}

function checksPassed(runs) {
  if (!runs || !runs.length) return false;
  return runs.every(function (run) {
    if (run.conclusion === 'skipped' || run.conclusion === 'neutral') return true;
    return run.status === 'completed' && run.conclusion === 'success';
  });
}

async function bytesOf(response) {
  if (!response) return Buffer.alloc(0);
  if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer());
  if (typeof response.text === 'function') return Buffer.from(await response.text());
  return Buffer.alloc(0);
}

function objectUrl(site, path) {
  return site.url + '/storage/v1/object/admin-staging/' + path.split('/').map(encodeURIComponent).join('/');
}

async function downloadStaged(env, path, fetchImpl) {
  const site = publicSupabase();
  const response = await fetchImpl(objectUrl(site, path), { headers: serviceHeaders(env) });
  if (!response || !response.ok) return null;
  return bytesOf(response);
}

function pageHtml() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner board</title><link rel="stylesheet" href="/visual.css"><style>main{max-width:880px;margin:0 auto;padding:24px 16px 48px}h1{font-size:var(--title);font-weight:500}button,a.action{min-height:44px;border-radius:var(--radius);border:1px solid var(--line);background:var(--gold);color:var(--gold-ink);padding:0 16px;font:inherit}.drop{margin:16px 0;padding:28px;border:1px dashed var(--line);border-radius:var(--radius);text-align:center}ul{list-style:none;padding:0}li{display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}img{max-width:96px;max-height:64px}#publish{font-size:18px;width:100%;margin-top:12px}.flag{color:var(--gold)}</style></head><body><main><h1>Owner board</h1><p id="board-status" role="status"></p><div id="drop" class="drop">Drop site files here. Paths stay inside website/ and assets/.</div><ul id="pending"></ul><button id="publish" type="button">Publish</button><p id="pr"></p><button id="ship" type="button">Ship it</button> <button id="rollback" type="button">Undo</button><section><h2>Overseer</h2><p id="flag"></p><ul id="checks"></ul></section></main><script src="/admin/board.js" defer></script></body></html>';
}

async function handleAdmin(req, env, fetchImpl) {
  const user = await adminUser(req, env, fetchImpl);
  const payload = parseBody(req);
  if (req && req.method === 'POST' && payload.action === 'leave') {
    return {
      status: 200,
      body: { ok: true },
      headers: { 'set-cookie': 'valos_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' }
    };
  }
  if (req && req.method === 'POST' && payload.action === 'enter') {
    if (!user) return notFound();
    const token = bearer(req.headers);
    if (!token) return notFound();
    return {
      status: 200,
      body: { ok: true },
      headers: { 'set-cookie': 'valos_admin=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600' }
    };
  }
  if (!user) return notFound();
  if (req.method === 'GET') {
    const preview = previewPath(req.url);
    if (preview) {
      if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'Storage not configured' } };
      const file = await downloadStaged(env, preview, fetchImpl);
      if (!file) return notFound();
      const ext = (preview.split('.').pop() || '').toLowerCase();
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      return { status: 200, raw: file, type: types[ext] || 'application/octet-stream' };
    }
    return { status: 200, html: pageHtml(), type: 'text/html; charset=utf-8' };
  }
  return notFound();
}

function previewPath(url) {
  const query = String(url || '').split('?')[1] || '';
  const path = new URLSearchParams(query).get('preview') || '';
  return cleanPath(path);
}

function parseBody(req) {
  if (!req || !req.body) return {};
  try { return JSON.parse(req.body); }
  catch (error) { return {}; }
}

async function handlePush(req, env, fetchImpl, now) {
  const user = await adminUser(req, env, fetchImpl);
  if (!user) return notFound();
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const payload = parseBody(req);
  const action = String(payload.action || '');
  if (action === 'sign') return signUpload(env, payload, fetchImpl);
  if (action === 'scan') return scanUpload(env, payload, user, fetchImpl);
  if (action === 'list') return listUploads(env, user, fetchImpl);
  if (action === 'remove') return removeUpload(env, payload, user, fetchImpl);
  if (action === 'publish') return publishUploads(env, user, fetchImpl, now || Date.now());
  if (action === 'preview') return previewDeploy(env, payload, fetchImpl);
  if (action === 'ship') return shipPull(env, payload, fetchImpl);
  if (action === 'rollback') return rollbackProduction(env, fetchImpl);
  return { status: 400, body: { error: 'The request was not understood.' } };
}

async function signUpload(env, payload, fetchImpl) {
  const path = cleanPath(payload.path);
  const bytes = Number(payload.bytes || 0);
  if (!path) return { status: 400, body: { error: 'That path is not allowed.' } };
  if (!bytes || bytes > MAX_BYTES) return { status: 400, body: { error: 'Files must be 5 MB or smaller.' } };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'Storage not configured' } };
  const site = publicSupabase();
  const response = await fetchImpl(site.url + '/storage/v1/object/upload/sign/admin-staging/' + path.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify({ expiresIn: 120, upsert: true })
  });
  if (!response || !response.ok) return { status: 502, body: { error: 'The file was not staged.' } };
  const data = await response.json();
  const signed = data.url || data.signedUrl || '';
  if (!signed || signed.includes(env.SUPABASE_SERVICE_ROLE_KEY)) return { status: 502, body: { error: 'The file was not staged.' } };
  const uploadUrl = signed.startsWith('http') ? signed : site.url + '/storage/v1' + signed;
  return { status: 200, body: { uploadUrl: uploadUrl, path: path } };
}

async function scanUpload(env, payload, user, fetchImpl) {
  const path = cleanPath(payload.path);
  if (!path) return { status: 400, body: { error: 'That path is not allowed.' } };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'Storage not configured' } };
  const file = await downloadStaged(env, path, fetchImpl);
  if (!file) return { status: 400, body: { error: 'That file was not found.' } };
  if (file.length > MAX_BYTES || looksSecret(file)) {
    await fetchImpl(objectUrl(publicSupabase(), path), { method: 'DELETE', headers: serviceHeaders(env) });
    return { status: 400, body: { error: 'That file was refused.' } };
  }
  const site = publicSupabase();
  const saved = await fetchImpl(site.url + '/rest/v1/admin_uploads?on_conflict=user_id,path&select=path,bytes', {
    method: 'POST',
    headers: Object.assign(serviceHeaders(env), { prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ user_id: user.id, path: path, bytes: file.length, content_type: String(payload.type || '') })
  });
  if (!saved || !saved.ok) return { status: 502, body: { error: 'The file was not staged.' } };
  const rows = await saved.json();
  return { status: 200, body: { path: rows[0] && rows[0].path, bytes: file.length } };
}

async function listUploads(env, user, fetchImpl) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'Storage not configured' } };
  const site = publicSupabase();
  const response = await fetchImpl(site.url + '/rest/v1/admin_uploads?user_id=eq.' + encodeURIComponent(user.id) + '&select=path,bytes,content_type', { headers: serviceHeaders(env) });
  const rows = response && response.ok ? await response.json() : [];
  return { status: 200, body: { uploads: Array.isArray(rows) ? rows : [] } };
}

async function removeUpload(env, payload, user, fetchImpl) {
  const path = cleanPath(payload.path);
  if (!path || !env.SUPABASE_SERVICE_ROLE_KEY) return { status: 400, body: { error: 'That file was not removed.' } };
  const site = publicSupabase();
  await fetchImpl(objectUrl(site, path), { method: 'DELETE', headers: serviceHeaders(env) });
  await fetchImpl(site.url + '/rest/v1/admin_uploads?user_id=eq.' + encodeURIComponent(user.id) + '&path=eq.' + encodeURIComponent(path), { method: 'DELETE', headers: serviceHeaders(env) });
  return { status: 200, body: { ok: true } };
}

async function stagedFiles(env, user, fetchImpl) {
  const listed = await listUploads(env, user, fetchImpl);
  const rows = listed.body && listed.body.uploads || [];
  const files = [];
  for (const row of rows) {
    const path = cleanPath(row.path);
    if (!path) return { error: 'That path is not allowed.' };
    const file = await downloadStaged(env, path, fetchImpl);
    if (!file || file.length > MAX_BYTES || looksSecret(file)) return { error: 'That file was refused.' };
    files.push({ path: path, content: file.toString('base64') });
  }
  return { files: files };
}

async function publishUploads(env, user, fetchImpl, now) {
  if (!env.GITHUB_PUSH_TOKEN) return { status: 503, body: { error: 'Push is not configured' } };
  const staged = await stagedFiles(env, user, fetchImpl);
  if (staged.error) return { status: 400, body: { error: staged.error } };
  if (!staged.files.length) return { status: 400, body: { error: 'Nothing is waiting.' } };
  const headers = githubHeaders(env);
  const base = 'https://api.github.com/repos/' + REPO;
  const ref = await fetchImpl(base + '/git/ref/heads/develop', { headers: headers });
  const refBody = ref && ref.ok ? await ref.json() : null;
  const parent = refBody && refBody.object && refBody.object.sha;
  if (!parent) return { status: 502, body: { error: 'The branch was not created.' } };
  const commit = await fetchImpl(base + '/git/commits/' + parent, { headers: headers });
  const commitBody = commit && commit.ok ? await commit.json() : null;
  const tree = commitBody && commitBody.tree && commitBody.tree.sha;
  if (!tree) return { status: 502, body: { error: 'The branch was not created.' } };
  const blobs = [];
  for (const file of staged.files) {
    const blob = await fetchImpl(base + '/git/blobs', { method: 'POST', headers: headers, body: JSON.stringify({ content: file.content, encoding: 'base64' }) });
    const blobBody = blob && blob.ok ? await blob.json() : null;
    if (!blobBody || !blobBody.sha) return { status: 502, body: { error: 'The branch was not created.' } };
    blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blobBody.sha });
  }
  const nextTree = await fetchImpl(base + '/git/trees', { method: 'POST', headers: headers, body: JSON.stringify({ base_tree: tree, tree: blobs }) });
  const treeBody = nextTree && nextTree.ok ? await nextTree.json() : null;
  const created = await fetchImpl(base + '/git/commits', { method: 'POST', headers: headers, body: JSON.stringify({ message: 'Update the site from the owner board.', tree: treeBody && treeBody.sha, parents: [parent] }) });
  const createdBody = created && created.ok ? await created.json() : null;
  const branch = 'owner/push-' + now;
  const updated = await fetchImpl(base + '/git/refs', { method: 'POST', headers: headers, body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: createdBody && createdBody.sha }) });
  if (!updated || !updated.ok) return { status: 502, body: { error: 'The branch was not created.' } };
  const pull = await fetchImpl(base + '/pulls', { method: 'POST', headers: headers, body: JSON.stringify({ title: 'Owner board update', head: branch, base: 'develop' }) });
  const pullBody = pull && pull.ok ? await pull.json() : null;
  if (!pullBody || !pullBody.number) return { status: 502, body: { error: 'The pull request was not opened.' } };
  return { status: 200, body: { branch: branch, number: pullBody.number, url: pullBody.html_url } };
}

async function previewDeploy(env, payload, fetchImpl) {
  const vercel = vercelProject(env);
  if (!vercel.token || !vercel.project) return { status: 503, body: { error: 'Preview is not configured' } };
  const response = await fetchImpl('https://api.vercel.com/v6/deployments?projectId=' + encodeURIComponent(vercel.project) + '&teamId=' + encodeURIComponent(vercel.team) + '&limit=20', {
    headers: { authorization: 'Bearer ' + vercel.token }
  });
  const body = response && response.ok ? await response.json() : {};
  const found = (body.deployments || []).find(function (item) {
    return item && item.meta && item.meta.githubCommitRef === payload.branch;
  });
  if (!found) return { status: 200, body: { pending: true } };
  if (found.readyState !== 'READY') return { status: 200, body: { pending: true, state: found.readyState } };
  return { status: 200, body: { url: 'https://' + found.url } };
}

async function shipPull(env, payload, fetchImpl) {
  if (!env.GITHUB_PUSH_TOKEN) return { status: 503, body: { error: 'Push is not configured' } };
  const number = Number(payload.number || 0);
  if (!number) return { status: 400, body: { error: 'There is no pull request to ship.' } };
  const headers = githubHeaders(env);
  const base = 'https://api.github.com/repos/' + REPO;
  const pull = await fetchImpl(base + '/pulls/' + number, { headers: headers });
  const pullBody = pull && pull.ok ? await pull.json() : null;
  const head = pullBody && pullBody.head && pullBody.head.ref;
  const sha = pullBody && pullBody.head && pullBody.head.sha;
  if (!pullBody || !pullBody.base || pullBody.base.ref !== 'develop' || String(head || '').indexOf('owner/push-') !== 0) {
    return { status: 400, body: { error: 'That pull request cannot be shipped.' } };
  }
  const checks = await fetchImpl(base + '/commits/' + sha + '/check-runs', { headers: headers });
  if (checks && checks.ok) {
    const checkBody = await checks.json();
    const runs = checkBody && checkBody.check_runs || [];
    if (runs.length && !checksPassed(runs)) return { status: 409, body: { error: 'Checks have not passed.' } };
  }
  const merged = await fetchImpl(base + '/pulls/' + number + '/merge', {
    method: 'PUT',
    headers: headers,
    body: JSON.stringify({ merge_method: 'squash' })
  });
  if (!merged || !merged.ok) return { status: 502, body: { error: 'The pull request was not merged.' } };
  return { status: 200, body: { ok: true } };
}

async function rollbackProduction(env, fetchImpl) {
  const vercel = vercelProject(env);
  if (!vercel.token || !vercel.project) return { status: 503, body: { error: 'Rollback is not configured' } };
  const response = await fetchImpl('https://api.vercel.com/v6/deployments?projectId=' + encodeURIComponent(vercel.project) + '&teamId=' + encodeURIComponent(vercel.team) + '&limit=10&state=READY&target=production', {
    headers: { authorization: 'Bearer ' + vercel.token }
  });
  const body = response && response.ok ? await response.json() : {};
  const target = previousReady(body.deployments);
  if (!target) return { status: 409, body: { error: 'There is no earlier production deployment.' } };
  const rolled = await fetchImpl('https://api.vercel.com/v1/projects/' + encodeURIComponent(vercel.project) + '/rollback/' + encodeURIComponent(target.uid) + '?teamId=' + encodeURIComponent(vercel.team), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + vercel.token, 'content-type': 'application/json' },
    body: '{}'
  });
  if (!rolled || !rolled.ok) return { status: 502, body: { error: 'Production was not rolled back.' } };
  return { status: 200, body: { ok: true, deployment: target.uid } };
}

const HEALTH = [
  { name: 'Apex', url: 'https://valhalla-app.xyz/', expect: 200 },
  { name: 'Desk', url: 'https://valhalla-app.xyz/os/', expect: 200 },
  { name: 'valos.live', url: 'https://valos.live/', expect: 200 },
  { name: 'Assistant', url: 'https://valhalla-app.xyz/api/ai', expect: [401, 405] },
  { name: 'Feed', url: 'https://valhalla-app.xyz/api/feed', expect: [401, 405] }
];

async function timeCheck(target, fetchImpl) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, 4000) : null;
  try {
    const response = await fetchImpl(target.url, { method: 'GET', signal: controller && controller.signal });
    const status = response && response.status ? response.status : 0;
    const ok = Array.isArray(target.expect) ? target.expect.indexOf(status) !== -1 : status >= 200 && status < 400;
    return { name: target.name, status: status, ok: ok };
  } catch (error) {
    return { name: target.name, status: 0, ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleOverseer(req, env, fetchImpl, now) {
  const cron = bearer(req.headers) && env.CRON_SECRET && bearer(req.headers) === env.CRON_SECRET;
  const user = cron ? null : await adminUser(req, env, fetchImpl);
  if (!cron && !user) return notFound();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'Overseer not configured' } };
  const site = publicSupabase();
  const prior = await fetchImpl(site.url + '/rest/v1/overseer_runs?select=deploy_failed,rollback_recommended,report,created_at&order=created_at.desc&limit=1', { headers: serviceHeaders(env) });
  const rows = prior && prior.ok ? await prior.json() : [];
  const latest = Array.isArray(rows) ? rows[0] : null;
  const stamp = now || Date.now();
  if (!cron && req.method === 'GET') return { status: 200, body: { latest: latest || null } };
  if (!cron && latest && latest.created_at && stamp - Date.parse(latest.created_at) < CHECK_GAP_MS) {
    return { status: 200, body: { latest: latest } };
  }
  const checks = await Promise.all(HEALTH.map(function (target) { return timeCheck(target, fetchImpl); }));
  const vercel = vercelProject(env);
  let deployFailed = false;
  let deployment = '';
  if (vercel.token && vercel.project) {
    const response = await fetchImpl('https://api.vercel.com/v6/deployments?projectId=' + encodeURIComponent(vercel.project) + '&teamId=' + encodeURIComponent(vercel.team) + '&limit=1&target=production', {
      headers: { authorization: 'Bearer ' + vercel.token }
    });
    const body = response && response.ok ? await response.json() : {};
    const current = body.deployments && body.deployments[0];
    deployment = current && current.uid || '';
    deployFailed = !!(current && (current.readyState === 'ERROR' || current.state === 'ERROR'));
  }
  const rollbackRecommended = !!(deployFailed && latest && latest.deploy_failed);
  const report = { checks: checks, deployment: deployment, deployFailed: deployFailed, rollbackRecommended: rollbackRecommended };
  await fetchImpl(site.url + '/rest/v1/overseer_runs', {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify({ deploy_failed: deployFailed, rollback_recommended: rollbackRecommended, report: report })
  });
  return { status: 200, body: { latest: { deploy_failed: deployFailed, rollback_recommended: rollbackRecommended, report: report } } };
}

module.exports = {
  cleanPath: cleanPath,
  looksSecret: looksSecret,
  previousReady: previousReady,
  checksPassed: checksPassed,
  handleAdmin: handleAdmin,
  handlePush: handlePush,
  handleOverseer: handleOverseer,
  CHECK_GAP_MS: CHECK_GAP_MS
};
