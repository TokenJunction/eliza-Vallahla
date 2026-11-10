'use strict';

const { publicSupabase } = require('./feed-core.cjs');
const { DEFAULT_MODEL, FALLBACK_MODEL } = require('./ai-core.cjs');

const CHARACTERS = {
  wren: require('../../characters/wren.json'),
  droid: require('../../characters/droid.json'),
  forge: require('../../characters/forge.json'),
  sentinel: require('../../characters/sentinel.json'),
  gauge: require('../../characters/gauge.json'),
  skald: require('../../characters/skald.json'),
  herald: require('../../characters/herald.json'),
  muse: require('../../characters/muse.json'),
  tinker: require('../../characters/tinker.json'),
  ledger: require('../../characters/ledger.json'),
  conductor: require('../../characters/conductor.json')
};
const ROSTER = ['wren', 'droid', 'forge', 'sentinel', 'gauge', 'skald', 'herald', 'muse', 'tinker', 'ledger'];
const MAX_INPUT = 2000;
const hits = new Map();
const ROUTES = [
  ['wren', /\b(ops|health|outage|deploy|status)\b/i],
  ['droid', /\b(research|source|paper|study)\b/i],
  ['forge', /\b(code|bug|patch|function|refactor)\b/i],
  ['sentinel', /\b(security|secret|auth|vulnerability)\b/i],
  ['gauge', /\b(cost|spend|budget|invoice)\b/i],
  ['skald', /\b(marketing|copy|announce|campaign)\b/i],
  ['herald', /\b(edition|release|changelog|notes)\b/i],
  ['muse', /\b(ux|layout|screen|design)\b/i],
  ['tinker', /\b(desktop|window|dock|shell)\b/i],
  ['ledger', /\b(product|plan|trial|entitlement)\b/i]
];

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function loadCharacter(id) {
  if (id === 'zeus' || !CHARACTERS[id]) return null;
  const character = CHARACTERS[id];
  if (/zeus/i.test(character.name || '')) return null;
  return character;
}

function secretLike(text) {
  const words = String(text || '').trim().toLowerCase().split(/\s+/);
  const phrase = words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); });
  return phrase || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(String(text || ''));
}

function allow(userId, now) {
  const recent = (hits.get(userId) || []).filter(function (at) { return now - at < 60000; });
  if (recent.length >= 6) {
    hits.set(userId, recent);
    return false;
  }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

function routeTask(text) {
  const found = ROUTES.find(function (row) { return row[1].test(text); });
  return found ? found[0] : 'wren';
}

function classify(text) {
  const value = String(text || '');
  if (/\b(merge|pull request)\b/i.test(value)) return { mode: 'approval', kind: 'merge' };
  if (/\b(pay|charge|refund|invoice|transfer|send money)\b/i.test(value)) return { mode: 'approval', kind: 'money' };
  if (/\b(dns|domain|nameserver)\b/i.test(value)) return { mode: 'approval', kind: 'dns' };
  if (/\b(post|tweet|publish|broadcast)\b/i.test(value)) return { mode: 'approval', kind: 'post' };
  if (/\b(trade|buy|sell|swap)\b/i.test(value)) return { mode: 'approval', kind: 'trade' };
  if (/\b(draft|recommend)\b/i.test(value)) return { mode: 'draft', kind: 'draft' };
  return { mode: 'answer', kind: 'answer' };
}

function customerNode(env) {
  return String(env && env.NODE_ROLE || 'customer') !== 'coordinator';
}

async function verifyUser(token, fetchImpl) {
  const site = publicSupabase();
  if (!site.url || !site.key || !token) return null;
  const response = await fetchImpl(site.url + '/auth/v1/user', {
    headers: { authorization: 'Bearer ' + token, apikey: site.key }
  });
  if (!response || !response.ok) return null;
  const user = await response.json();
  return user && user.id ? user : null;
}

async function completeFree(env, system, task, fetchImpl) {
  const key = String(env && env.OPENROUTER_API_KEY || '');
  if (!key) return { brain: 'offline', reply: '' };
  const models = [DEFAULT_MODEL, FALLBACK_MODEL];
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    if (!model.endsWith(':free')) continue;
    const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://valhalla-app.xyz',
        'X-Title': 'ValhallaOS'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: task }
        ]
      })
    });
    if (response && response.status === 429) continue;
    if (!response || !response.ok) continue;
    const body = await response.json();
    const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (typeof text === 'string' && text.trim() && !text.includes(key)) return { brain: model, reply: text.trim() };
  }
  return { brain: 'offline', reply: '' };
}

async function askBrain(env, system, task, fetchImpl) {
  const home = String(env && env.VLLM_BASE_URL || '');
  if (home) {
    try {
      const response = await fetchImpl(home.replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'local',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: task }
          ]
        })
      });
      if (response && response.ok) {
        const body = await response.json();
        const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
        if (typeof text === 'string' && text.trim()) return { brain: 'vllm', reply: text.trim() };
      }
    } catch (error) {
      /* home model offline */
    }
  }
  const free = await completeFree(env, system, task, fetchImpl);
  if (free.reply) return free;
  return { brain: 'offline', reply: 'The home model is offline.' };
}

async function readHealth(env, fetchImpl) {
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  const site = publicSupabase();
  if (!key || !site.url) return { connected: false, label: 'Overseer not connected' };
  const response = await fetchImpl(site.url + '/rest/v1/overseer_runs?select=rollback_recommended,created_at&order=created_at.desc&limit=1', {
    headers: { authorization: 'Bearer ' + key, apikey: key, accept: 'application/json' }
  });
  if (!response || !response.ok) return { connected: false, label: 'Overseer not connected' };
  const rows = await response.json();
  const latest = Array.isArray(rows) ? rows[0] : null;
  if (!latest) return { connected: true, label: 'No overseer check stored yet.' };
  return { connected: true, label: latest.rollback_recommended ? 'Roll back recommended' : 'Last check stored.' };
}

async function storeApproval(env, user, item, fetchImpl) {
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  const site = publicSupabase();
  if (!key || !site.url) return { stored: false };
  const response = await fetchImpl(site.url + '/rest/v1/mecha_approvals', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, apikey: key, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.id, kind: item.kind, mecha: item.mecha, task: item.task, status: 'pending' })
  });
  return { stored: !!(response && response.ok) };
}

async function handleMechas(req, env, fetchImpl, now) {
  if (!req || (req.method !== 'GET' && req.method !== 'POST')) return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  let user;
  try { user = await verifyUser(token, fetchImpl); }
  catch (error) { return { status: 401, body: { error: 'Sign-in required.' } }; }
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  const roster = ROSTER.map(loadCharacter).filter(Boolean).map(function (character) { return character.name; });
  const health = await readHealth(env, fetchImpl);
  const deskHealth = { connected: health.connected, label: health.label };
  if (req.method === 'GET') {
    return { status: 200, body: { supervisor: 'Conductor', mechas: roster, health: deskHealth, zeus: false } };
  }
  let payload = {};
  try { payload = JSON.parse(req.body || '{}'); }
  catch (error) { return { status: 400, body: { error: 'The request was not understood.' } }; }
  const task = String(payload.task || '').trim();
  if (!task) return { status: 400, body: { error: 'A task is required.' } };
  if (task.length > MAX_INPUT) return { status: 400, body: { error: 'That task is too long.' } };
  if (secretLike(task)) return { status: 400, body: { error: 'Do not share a seed phrase or private key.' } };
  if (!allow(user.id, now || Date.now())) return { status: 429, body: { error: 'Too many Mecha requests.' } };
  if (/zeus/i.test(task) || payload.mecha === 'zeus') {
    return { status: 400, body: { error: 'Zeus does not run on customer nodes.' } };
  }
  if (customerNode(env) && /zeus/i.test(String(payload.node || ''))) {
    return { status: 400, body: { error: 'Zeus does not run on customer nodes.' } };
  }
  const mechaId = routeTask(task);
  const character = loadCharacter(mechaId);
  const supervisor = loadCharacter('conductor');
  if (!character || !supervisor) return { status: 500, body: { error: 'That Mecha is not available.' } };
  const action = classify(task);
  if (action.mode === 'approval') {
    const saved = await storeApproval(env, user, { kind: action.kind, mecha: character.name, task: task }, fetchImpl);
    if (!saved.stored) return { status: 503, body: { error: 'That approval was not saved.', pending: false, executed: false } };
    return {
      status: 200,
      body: {
        supervisor: supervisor.name,
        mecha: character.name,
        mode: 'approval',
        kind: action.kind,
        pending: true,
        reply: character.name + ' did not ' + action.kind + '. It is waiting on the admin board.',
        executed: false
      }
    };
  }
  const brain = await askBrain(env, supervisor.system + ' ' + character.system, task, fetchImpl);
  return {
    status: 200,
    body: {
      supervisor: supervisor.name,
      mecha: character.name,
      mode: action.mode,
      brain: brain.brain,
      reply: brain.reply,
      health: health.label,
      executed: false
    }
  };
}

module.exports = {
  classify: classify,
  routeTask: routeTask,
  loadCharacter: loadCharacter,
  handleMechas: handleMechas,
  customerNode: customerNode,
  resetMechaLimits: function () { hits.clear(); }
};
