import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TEAM_ID = 'team_AsAJ3GVmfx8BxRUIQdEcZrgv';
const PROJECT = 'eliza-valhalla';
const STATUS_TITLE = 'Zeus Sentinel status';
const REVIEW_HEAD = 'Zeus pre-review:';

export const CHECKS = [
  { id: 'valhalla-app.xyz', url: 'https://valhalla-app.xyz/', accept: [200] },
  { id: 'www.valhalla-app.xyz', url: 'https://www.valhalla-app.xyz/', accept: [200] },
  { id: 'os', url: 'https://valhalla-app.xyz/os/', accept: [200] },
  { id: 'valos.live', url: 'https://valos.live/', accept: [200] },
  { id: 'api/ai', url: 'https://valhalla-app.xyz/api/ai', accept: [401, 405] },
  { id: 'api/feed', url: 'https://valhalla-app.xyz/api/feed', accept: [401] }
];

const SECRET_RULES = [
  { reason: 'sk_ pattern', re: /sk_[A-Za-z0-9]/ },
  { reason: 'sb_secret_ pattern', re: /sb_secret_/ },
  { reason: 'hf_ pattern', re: /hf_[A-Za-z0-9]/ },
  { reason: 'private key', re: /PRIVATE KEY/i },
  { reason: 'bearer token', re: /Bearer\s+[A-Za-z0-9._~+/-]{8,}/ }
];

export function addedText(patch) {
  return String(patch || '')
    .split('\n')
    .filter(function (line) { return line.startsWith('+') && !line.startsWith('+++'); })
    .map(function (line) { return line.slice(1); })
    .join('\n');
}

export function scanSecrets(text) {
  const found = [];
  SECRET_RULES.forEach(function (rule) {
    if (rule.re.test(String(text || ''))) found.push(rule.reason);
  });
  return found;
}

export function isPublicFile(filename) {
  const path = String(filename || '').replace(/\\/g, '/');
  return path.includes('/os/') || path.endsWith('.html');
}

export function reviewFile(file) {
  const path = String(file && file.filename || '');
  const text = addedText(file && file.patch);
  const flags = [];
  if (!file || file.patch == null) {
    if (/\.(js|mjs|cjs|html|yml|yaml|json|md|py|sh)$/i.test(path)) flags.push({ path: path, reason: 'diff unavailable' });
    return flags;
  }
  scanSecrets(text).forEach(function (reason) { flags.push({ path: path, reason: reason }); });
  if (/3des|des-ede3/i.test(text)) flags.push({ path: path, reason: '3DES' });
  if (/\bDNS\b|A-record|A record/i.test(text)) flags.push({ path: path, reason: 'DNS or A-record' });
  if (/\bwallet\b|\btrading\b/i.test(text)) flags.push({ path: path, reason: 'wallet or trading change' });
  if (isPublicFile(path)) {
    const serverKey = /OPENROUTER_API_KEY|HF_TOKEN|VERCEL_TOKEN|SUPABASE_SERVICE_ROLE|GPU_NODE_KEY|AI_BYOK_ENC_KEY|process\.env\.[A-Z0-9_]*KEY/;
    if (serverKey.test(text) || scanSecrets(text).length) flags.push({ path: path, reason: 'server key referenced in a public file' });
  }
  return flags;
}

export function reviewVerdict(flags) {
  return flags.length ? 'FLAG' : 'PASS';
}

export function reviewComment(flags) {
  const verdict = reviewVerdict(flags);
  if (!flags.length) return REVIEW_HEAD + ' PASS\n\nNo secret pattern, 3DES, DNS, wallet, or trading change in the diff.';
  const lines = flags.map(function (flag) { return '- `' + flag.path + '`: ' + flag.reason; });
  return REVIEW_HEAD + ' FLAG\n\n' + lines.join('\n');
}

export function lastRollbackAt(comments) {
  if (!Array.isArray(comments)) return null;
  let latest = null;
  comments.forEach(function (comment) {
    const match = String(comment && comment.body || '').match(/rollback-at:\s*([0-9T:Z.+-]+)/);
    if (!match) return;
    const at = Date.parse(match[1]);
    if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
  });
  return latest;
}

export function rollbackDecision(input) {
  if (!input || !input.siteDown) return { action: 'skip', reason: 'site checks passed' };
  if (input.historyKnown === false) return { action: 'skip', reason: 'rollback history could not be read' };
  if (!input.hasToken) return { action: 'skip', reason: 'VERCEL_TOKEN is not set' };
  if (!input.deploymentId) return { action: 'skip', reason: 'ZEUS_LAST_VERIFIED_DEPLOYMENT is not set' };
  if (input.alreadyRolledBack) return { action: 'skip', reason: 'this run already rolled back once' };
  if (input.lastRollbackAt != null && input.now - input.lastRollbackAt < SIX_HOURS_MS) {
    return { action: 'skip', reason: 'a rollback already happened in the last 6 hours' };
  }
  return { action: 'rollback', deploymentId: input.deploymentId };
}

export function freeModelsFrom(source) {
  const found = new Set();
  const pattern = /['"]([A-Za-z0-9._/-]+:free)['"]/g;
  let match = pattern.exec(String(source || ''));
  while (match) {
    found.add(match[1]);
    match = pattern.exec(String(source || ''));
  }
  return Array.from(found);
}

export function formatEt(now) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(now));
}

export async function checkUrl(check, deps) {
  const attempts = deps.attempts || 3;
  const gapMs = deps.gapMs == null ? 30_000 : deps.gapMs;
  const timeoutMs = deps.timeoutMs == null ? 20_000 : deps.timeoutMs;
  let last = { id: check.id, url: check.url, ok: false, status: 0, ms: null, attempts: 0 };
  for (let n = 1; n <= attempts; n += 1) {
    if (n > 1) await deps.sleep(gapMs);
    const start = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      const response = await deps.fetchImpl(check.url, { method: 'GET', signal: controller ? controller.signal : undefined });
      const status = response && typeof response.status === 'number' ? response.status : 0;
      last = { id: check.id, url: check.url, ok: status < 500 && check.accept.includes(status), status: status, ms: Date.now() - start, attempts: n };
      if (last.ok) return last;
    } catch (error) {
      last = { id: check.id, url: check.url, ok: false, status: 0, ms: Date.now() - start, attempts: n, error: error.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return last;
}

export function promoteUrl(deploymentId) {
  return 'https://api.vercel.com/v10/projects/' + PROJECT + '/promote/' + encodeURIComponent(deploymentId) + '?teamId=' + TEAM_ID;
}

export function buildReport(state) {
  const when = formatEt(state.now);
  const rows = state.checks.map(function (check) {
    return '| ' + when + ' | ' + check.id + ' | ' + (check.ok ? 'up' : 'down') + ' | ' + (check.ms == null ? '' : check.ms + ' ms') + ' |';
  });
  const models = (state.models || []).map(function (model) {
    const stateLabel = model.skipped ? 'skipped' : (model.limited ? 'limited' : (model.up ? 'up' : 'down'));
    return '| ' + model.model + ' | ' + stateLabel + ' |';
  });
  const flags = (state.flags || []).map(function (flag) { return '- ' + flag.pull + ' `' + flag.path + '`: ' + flag.reason; });
  return [
    '# ' + STATUS_TITLE,
    '',
    '| Time (ET) | Check | Result | Latency |',
    '| --- | --- | --- | --- |',
    rows.join('\n'),
    '',
    '## Models',
    '',
    models.length ? '| Model | State |\n| --- | --- |\n' + models.join('\n') : 'Model check skipped.',
    '',
    '## Rollback',
    '',
    state.rollback || 'none',
    '',
    '## PR flags',
    '',
    flags.length ? flags.join('\n') : 'none'
  ].join('\n');
}

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token,
    'user-agent': 'zeus-sentinel',
    'x-github-api-version': '2022-11-28'
  };
}

async function githubJson(fetchImpl, token, url, init) {
  const response = await fetchImpl(url, Object.assign({ headers: githubHeaders(token) }, init || {}));
  const text = response && typeof response.text === 'function' ? await response.text() : '';
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (error) { body = { message: text }; }
  }
  return { ok: Boolean(response && response.ok), status: response ? response.status : 0, body: body };
}

export async function run(env, deps) {
  const fetchImpl = deps.fetchImpl;
  const sleep = deps.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  const now = deps.now || Date.now();
  const gapMs = deps.gapMs == null ? 30_000 : deps.gapMs;
  const timeoutMs = deps.timeoutMs == null ? 20_000 : deps.timeoutMs;
  const checks = [];
  for (const check of CHECKS) checks.push(await checkUrl(check, { fetchImpl: fetchImpl, sleep: sleep, gapMs: gapMs, timeoutMs: timeoutMs }));
  let siteDown = checks.some(function (check) { return !check.ok; });
  let rollback = 'not needed';
  let already = false;
  if (siteDown) {
    const history = await deps.readRollbackHistory();
    const decision = rollbackDecision({
      siteDown: true,
      historyKnown: history.known,
      hasToken: Boolean(env.VERCEL_TOKEN),
      deploymentId: env.ZEUS_LAST_VERIFIED_DEPLOYMENT || '',
      lastRollbackAt: history.at,
      alreadyRolledBack: already,
      now: now
    });
    if (decision.action === 'rollback') {
      const promoted = await fetchImpl(promoteUrl(decision.deploymentId), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.VERCEL_TOKEN }
      });
      if (!promoted || !promoted.ok) {
        rollback = 'promote failed status ' + (promoted && promoted.status);
      } else {
        already = true;
        rollback = 'promoted ' + decision.deploymentId + ' status ' + promoted.status;
        await deps.recordRollback(new Date(now).toISOString());
        checks.length = 0;
        for (const check of CHECKS) checks.push(await checkUrl(check, { fetchImpl: fetchImpl, sleep: sleep, gapMs: gapMs, timeoutMs: timeoutMs }));
        siteDown = checks.some(function (check) { return !check.ok; });
      }
    } else {
      rollback = decision.reason;
    }
  }
  const models = await deps.probeModels();
  const flags = await deps.reviewPulls();
  const report = buildReport({ now: now, checks: checks, models: models, rollback: rollback, flags: flags });
  await deps.publishReport(report);
  return { exitCode: siteDown ? 1 : 0, report: report, rollback: rollback };
}

async function defaultReadHistory(env, fetchImpl) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { known: false, at: null };
  const listed = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues?state=open&per_page=100');
  if (!listed.ok || !Array.isArray(listed.body)) return { known: false, at: null };
  const issue = listed.body.find(function (item) { return item && item.title === STATUS_TITLE && !item.pull_request; });
  if (!issue) return { known: true, at: null, issue: null };
  const comments = await githubJson(fetchImpl, env.GITHUB_TOKEN, issue.comments_url);
  if (!comments.ok || !Array.isArray(comments.body)) return { known: false, at: null, issue: issue };
  return { known: true, at: lastRollbackAt(comments.body), issue: issue };
}

export async function recordRollback(env, fetchImpl, issue, stamp) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return issue || null;
  let current = issue;
  if (!current) {
    const created = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues', {
      method: 'POST',
      body: JSON.stringify({ title: STATUS_TITLE, body: 'rollback-at: ' + stamp })
    });
    if (!created.ok || !created.body || !created.body.number) return null;
    current = created.body;
  }
  await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + current.number + '/comments', {
    method: 'POST',
    body: JSON.stringify({ body: 'rollback-at: ' + stamp })
  });
  await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + current.number + '/labels', {
    method: 'POST',
    body: JSON.stringify({ labels: ['zeus-rollback'] })
  });
  return current;
}

async function defaultPublish(env, fetchImpl, issue, report) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return;
  if (issue) {
    await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + issue.number, {
      method: 'PATCH',
      body: JSON.stringify({ title: STATUS_TITLE, body: report })
    });
    await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + issue.number + '/pin', { method: 'PUT' });
    return;
  }
  const created = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues', {
    method: 'POST',
    body: JSON.stringify({ title: STATUS_TITLE, body: report })
  });
  if (created.ok && created.body && created.body.number) {
    await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + created.body.number + '/pin', { method: 'PUT' });
  }
}

async function defaultProbe(env, fetchImpl) {
  if (!env.OPENROUTER_API_KEY) return [{ model: '(none)', skipped: true }];
  const sources = ['api/ai.js', 'website/scripts/ai-core.cjs'].map(function (path) {
    try { return readFileSync(path, 'utf8'); } catch (error) { return ''; }
  }).join('\n');
  const models = freeModelsFrom(sources);
  const results = [];
  for (const model of models) {
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    });
    const status = response && response.status ? response.status : 0;
    results.push({ model: model, up: status === 200, limited: status === 429, skipped: false });
  }
  return results;
}

async function defaultReview(env, fetchImpl) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return [];
  const pulls = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/pulls?state=open&per_page=50');
  if (!pulls.ok || !Array.isArray(pulls.body)) return [];
  const flags = [];
  for (const pull of pulls.body) {
    const files = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/pulls/' + pull.number + '/files?per_page=100');
    const found = [];
    (Array.isArray(files.body) ? files.body : []).forEach(function (file) {
      reviewFile(file).forEach(function (flag) { found.push(flag); });
    });
    const body = reviewComment(found);
    const comments = await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + pull.number + '/comments?per_page=100');
    const existing = Array.isArray(comments.body) ? comments.body.find(function (comment) { return String(comment.body || '').startsWith(REVIEW_HEAD); }) : null;
    if (existing) {
      await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/comments/' + existing.id, {
        method: 'PATCH',
        body: JSON.stringify({ body: body })
      });
    } else {
      await githubJson(fetchImpl, env.GITHUB_TOKEN, 'https://api.github.com/repos/' + env.GITHUB_REPOSITORY + '/issues/' + pull.number + '/comments', {
        method: 'POST',
        body: JSON.stringify({ body: body })
      });
    }
    found.forEach(function (flag) { flags.push({ pull: '#' + pull.number, path: flag.path, reason: flag.reason }); });
  }
  return flags;
}

async function main() {
  const env = process.env;
  const history = await defaultReadHistory(env, fetch);
  const state = { issue: history.issue || null };
  const result = await run(env, {
    fetchImpl: fetch,
    now: Date.now(),
    readRollbackHistory: async function () { return history; },
    recordRollback: async function (stamp) {
      state.issue = await recordRollback(env, fetch, state.issue, stamp);
    },
    publishReport: function (report) {
      process.stdout.write(report + '\n');
      return defaultPublish(env, fetch, state.issue, report);
    },
    probeModels: function () { return defaultProbe(env, fetch); },
    reviewPulls: function () { return defaultReview(env, fetch); }
  });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(function (error) {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exitCode = 1;
  });
}
