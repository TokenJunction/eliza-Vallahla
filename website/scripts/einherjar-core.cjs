'use strict';

const crypto = require('node:crypto');
const { publicSupabase } = require('./feed-core.cjs');

const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_MODEL = 'meta-llama/Llama-3.2-3B-Instruct';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 20 * 1000;
const PROVIDERS = ['byok', 'huggingface', 'openrouter', 'overseer', 'gpu'];

const last = {};
PROVIDERS.forEach(function (id) { last[id] = { state: 'not configured', ms: null }; });

function resetProviderHealth() {
  PROVIDERS.forEach(function (id) { last[id] = { state: 'not configured', ms: null }; });
}

function note(id, state, ms) {
  last[id] = { state: state, ms: Number.isFinite(ms) ? ms : null };
}

function encKey(env) {
  const raw = String(env && env.AI_BYOK_ENC_KEY || '');
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

function sealByok(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function openByok(packed, key) {
  const buf = Buffer.from(String(packed), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

function scrub(text, secrets) {
  let out = String(text || '');
  (secrets || []).forEach(function (secret) {
    if (secret) out = out.split(secret).join('');
  });
  return out.trim();
}

function textOf(body) {
  const value = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return typeof value === 'string' ? value.trim() : '';
}

function tokensOf(body) {
  const usage = body && body.usage;
  const total = usage && (usage.total_tokens || usage.totalTokens);
  return Number.isFinite(Number(total)) ? Number(total) : 0;
}

async function timed(work) {
  const start = Date.now();
  try {
    const result = await work();
    return { result: result, ms: Date.now() - start };
  } catch (error) {
    return { result: { fall: true, state: 'down' }, ms: Date.now() - start };
  }
}

function withSignal(fetchImpl, timeoutMs) {
  const limit = timeoutMs || TIMEOUT_MS;
  return function (url, init) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, limit) : null;
    const next = Object.assign({}, init, controller ? { signal: controller.signal } : {});
    return Promise.resolve(fetchImpl(url, next)).finally(function () {
      if (timer) clearTimeout(timer);
    });
  };
}

function chatBody(model, message, system, maxTokens) {
  return {
    model: model,
    max_tokens: maxTokens || 600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: message }
    ]
  };
}

async function postChat(fetchImpl, url, headers, model, message, system, maxTokens) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(chatBody(model, message, system, maxTokens))
  });
  if (!response) return { fall: true, state: 'down' };
  const status = typeof response.status === 'number' ? response.status : 0;
  if (status === 402) return { fall: true, state: 'no credit' };
  if (status === 429) return { fall: true, state: 'down', busy: true };
  if (status >= 500) return { fall: true, state: 'down' };
  if (!response.ok) return { fall: true, state: 'down' };
  const body = typeof response.json === 'function' ? await response.json() : {};
  return { fall: false, state: 'up', reply: textOf(body), tokens: tokensOf(body), raw: body };
}

async function loadByok(env, user, fetchImpl) {
  const key = encKey(env);
  const role = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  const site = publicSupabase();
  if (!key || !role || !site.url || !user) return null;
  const response = await fetchImpl(site.url + '/rest/v1/ai_byok?user_id=eq.' + encodeURIComponent(user.id) + '&select=provider,ciphertext', {
    headers: { authorization: 'Bearer ' + role, apikey: role, accept: 'application/json' }
  });
  if (!response || !response.ok) return null;
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.ciphertext) return null;
  try {
    return { provider: row.provider === 'openai' ? 'openai' : 'openrouter', secret: openByok(row.ciphertext, key) };
  } catch (error) {
    return null;
  }
}

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function relayTranscript(packet) {
  return Buffer.from([packet.from, packet.to, String(packet.ts), packet.nonce, packet.eph, packet.iv, packet.tag, packet.box].join('.'));
}

function sealRelay(payload, opts) {
  const eph = crypto.generateKeyPairSync('x25519');
  const nonce = crypto.randomBytes(16);
  const agreePublic = crypto.createPublicKey(opts.agreePublic);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: agreePublic });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, nonce, 'valos-relay', 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const box = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const packet = {
    from: opts.from,
    to: 'overseer',
    ts: Date.now(),
    nonce: b64(nonce),
    eph: b64(eph.publicKey.export({ type: 'spki', format: 'der' })),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    box: b64(box)
  };
  packet.sig = b64(crypto.sign(null, relayTranscript(packet), crypto.createPrivateKey(opts.signPrivate)));
  return packet;
}

function capUsd(env) {
  if (!env || env.GPU_MONTHLY_CAP_USD == null || env.GPU_MONTHLY_CAP_USD === '') return 0;
  const value = Number(env.GPU_MONTHLY_CAP_USD);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const spent = new Map();

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function gpuSpend() {
  return spent.get(monthKey()) || 0;
}

function addGpuSpend(amount) {
  const key = monthKey();
  spent.set(key, (spent.get(key) || 0) + amount);
}

function resetGpuSpend() {
  spent.clear();
}

function providerView() {
  return PROVIDERS.map(function (id) {
    return { id: id, state: last[id].state, ms: last[id].ms };
  });
}

async function routeChat(input) {
  const env = input.env || {};
  const fetchImpl = withSignal(input.fetchImpl, input.timeoutMs);
  const message = input.message;
  const system = input.system;
  const secrets = [];
  let fallbacks = 0;
  let busy = false;

  async function attempt(id, run) {
    const timedResult = await timed(run);
    const result = timedResult.result || { fall: true, state: 'down' };
    if (result.fall) {
      note(id, result.state || 'down', timedResult.ms);
      fallbacks += 1;
      if (result.busy) busy = true;
      return null;
    }
    const reply = scrub(result.reply, secrets);
    if (!reply) {
      note(id, 'down', timedResult.ms);
      fallbacks += 1;
      return null;
    }
    note(id, 'up', timedResult.ms);
    return { reply: reply, provider: id, model: result.model, tokens: result.tokens || 0, ms: timedResult.ms, fallbacks: fallbacks + (result.switched ? 1 : 0) };
  }

  const byok = await loadByok(env, input.user, fetchImpl).catch(function () { return null; });
  if (!byok) note('byok', 'not configured', null);
  else {
    secrets.push(byok.secret);
    const target = byok.provider === 'openai'
      ? { url: OPENAI_URL, model: 'gpt-4o-mini' }
      : { url: OPENROUTER_URL, model: input.model };
    const hit = await attempt('byok', function () {
      return postChat(fetchImpl, target.url, { authorization: 'Bearer ' + byok.secret }, target.model, message, system, input.maxTokens).then(function (row) {
        return Object.assign({ model: target.model }, row);
      });
    });
    if (hit) return hit;
  }

  const hf = String(env.HF_TOKEN || '');
  if (!hf) note('huggingface', 'not configured', null);
  else {
    secrets.push(hf);
    const hit = await attempt('huggingface', function () {
      return postChat(fetchImpl, HF_URL, { authorization: 'Bearer ' + hf }, HF_MODEL, message, system, input.maxTokens).then(function (row) {
        return Object.assign({ model: HF_MODEL }, row);
      });
    });
    if (hit) return hit;
  }

  const openrouter = String(env.OPENROUTER_API_KEY || '');
  if (!openrouter) note('openrouter', 'not configured', null);
  else {
    secrets.push(openrouter);
    const primary = input.model;
    const secondary = input.fallbackModel;
    const hit = await attempt('openrouter', async function () {
      let row = await postChat(fetchImpl, OPENROUTER_URL, {
        authorization: 'Bearer ' + openrouter,
        'HTTP-Referer': 'https://valhalla-app.xyz',
        'X-Title': 'ValhallaOS'
      }, primary, message, system, input.maxTokens);
      if (row.fall && secondary && secondary !== primary) {
        const again = await postChat(fetchImpl, OPENROUTER_URL, {
          authorization: 'Bearer ' + openrouter,
          'HTTP-Referer': 'https://valhalla-app.xyz',
          'X-Title': 'ValhallaOS'
        }, secondary, message, system, input.maxTokens);
        if (again.fall) return { fall: true, state: 'down', busy: !!(row.busy && again.busy) };
        return Object.assign({ model: secondary, switched: true }, again);
      }
      if (row.fall) return { fall: true, state: 'down', busy: !!row.busy };
      return Object.assign({ model: primary }, row);
    });
    if (hit) return hit;
  }

  const overseer = String(env.OVERSEER_NODE_URL || '');
  if (!overseer || !env.RELAY_SIGN_PRIVATE || !env.OVERSEER_AGREE_PUBLIC) note('overseer', 'not configured', null);
  else {
    const hit = await attempt('overseer', async function () {
      const packet = sealRelay({ message: message }, {
        from: String(env.RELAY_NODE_ID || 'desk'),
        signPrivate: env.RELAY_SIGN_PRIVATE,
        agreePublic: env.OVERSEER_AGREE_PUBLIC
      });
      const response = await fetchImpl(overseer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(packet)
      });
      const status = response && response.status ? response.status : 0;
      if (status === 402) return { fall: true, state: 'no credit' };
      if (status === 429 || status >= 500 || !response || !response.ok) return { fall: true, state: 'down' };
      const body = typeof response.json === 'function' ? await response.json() : {};
      return { fall: false, reply: typeof body.reply === 'string' ? body.reply : '', model: 'overseer', tokens: 0 };
    });
    if (hit) return hit;
  }

  const gpuUrl = String(env.GPU_NODE_URL || '');
  const gpuKey = String(env.GPU_NODE_KEY || '');
  const cap = capUsd(env);
  if (!gpuUrl || !gpuKey || cap <= 0 || gpuSpend() >= cap) note('gpu', 'not configured', null);
  else {
    secrets.push(gpuKey);
    const price = Number(env.GPU_USD_PER_1K_TOKENS || 0);
    const hit = await attempt('gpu', function () {
      return postChat(fetchImpl, gpuUrl.replace(/\/$/, '') + '/v1/chat/completions', { authorization: 'Bearer ' + gpuKey }, 'local', message, system, input.maxTokens).then(function (row) {
        if (!row.fall && price > 0) addGpuSpend((row.tokens || 0) / 1000 * price);
        return Object.assign({ model: 'local' }, row);
      });
    });
    if (hit) return hit;
  }

  return { reply: '', busy: busy, fallbacks: fallbacks };
}

async function markProbe(id, run) {
  const timedResult = await timed(run);
  const result = timedResult.result || { fall: true, state: 'down' };
  note(id, result.fall ? (result.state || 'down') : 'up', timedResult.ms);
}

async function providerHealth(env, user, fetchImpl, timeoutMs) {
  const call = withSignal(fetchImpl, timeoutMs);
  const byok = await loadByok(env, user, call).catch(function () { return null; });
  if (!byok) note('byok', 'not configured', null);
  else {
    const target = byok.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL;
    await markProbe('byok', function () {
      return postChat(call, target, { authorization: 'Bearer ' + byok.secret }, 'gpt-4o-mini', 'ping', 'Reply with ok.');
    });
  }
  if (!env.HF_TOKEN) note('huggingface', 'not configured', null);
  else {
    await markProbe('huggingface', function () {
      return postChat(call, HF_URL, { authorization: 'Bearer ' + env.HF_TOKEN }, HF_MODEL, 'ping', 'Reply with ok.');
    });
  }
  if (!env.OPENROUTER_API_KEY) note('openrouter', 'not configured', null);
  else {
    await markProbe('openrouter', function () {
      return postChat(call, OPENROUTER_URL, { authorization: 'Bearer ' + env.OPENROUTER_API_KEY }, inputModel(), 'ping', 'Reply with ok.');
    });
  }
  if (!env.OVERSEER_NODE_URL || !env.RELAY_SIGN_PRIVATE || !env.OVERSEER_AGREE_PUBLIC) note('overseer', 'not configured', null);
  else {
    await markProbe('overseer', async function () {
      const packet = sealRelay({ message: 'ping' }, {
        from: String(env.RELAY_NODE_ID || 'desk'),
        signPrivate: env.RELAY_SIGN_PRIVATE,
        agreePublic: env.OVERSEER_AGREE_PUBLIC
      });
      const response = await call(env.OVERSEER_NODE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(packet)
      });
      const status = response && response.status ? response.status : 0;
      if (status === 402) return { fall: true, state: 'no credit' };
      if (status === 429 || status >= 500 || !response || !response.ok) return { fall: true, state: 'down' };
      return { fall: false, state: 'up' };
    });
  }
  if (!env.GPU_NODE_URL || !env.GPU_NODE_KEY || capUsd(env) <= 0) note('gpu', 'not configured', null);
  else {
    await markProbe('gpu', function () {
      return postChat(call, String(env.GPU_NODE_URL).replace(/\/$/, '') + '/v1/chat/completions', { authorization: 'Bearer ' + env.GPU_NODE_KEY }, 'local', 'ping', 'Reply with ok.');
    });
  }
  return { providers: providerView() };
}

function inputModel() {
  return 'nvidia/nemotron-3.5-lightning:free';
}

module.exports = {
  HF_URL: HF_URL,
  sealByok: sealByok,
  encKey: encKey,
  routeChat: routeChat,
  providerHealth: providerHealth,
  resetProviderHealth: resetProviderHealth,
  resetGpuSpend: resetGpuSpend,
  capUsd: capUsd,
  PROVIDERS: PROVIDERS
};
