'use strict';

const crypto = require('node:crypto');
const { publicSupabase } = require('./feed-core.cjs');

const SERVICES = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  helius: 'Helius',
  stripe: 'Stripe',
  custom: 'Custom REST'
};

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function keyBytes(env) {
  const raw = String(env && env.CONNECTIONS_ENC_KEY || '');
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64');
}

function decryptSecret(packed, key) {
  const buf = Buffer.from(String(packed), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function last4(secret) {
  const text = String(secret || '');
  return text.slice(-4);
}

function hashKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function safeBase(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch (error) { return ''; }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return '';
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host)) return '';
  return parsed.origin;
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

function rest(site, token, path, init) {
  const headers = Object.assign({
    authorization: 'Bearer ' + token,
    apikey: site.key,
    accept: 'application/json'
  }, init && init.headers);
  return Object.assign({}, init, { headers: headers });
}

function plainError(status) {
  if (status === 401 || status === 403) return 'That key was rejected.';
  if (status === 429) return 'That service is busy. Try again shortly.';
  if (!status) return 'That service did not answer.';
  return 'That service did not accept the key.';
}

async function ping(service, secret, base, fetchImpl) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, 4000) : null;
  try {
    let response;
    if (service === 'openai') {
      response = await fetchImpl('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + secret }, signal: controller && controller.signal });
    } else if (service === 'openrouter') {
      response = await fetchImpl('https://openrouter.ai/api/v1/models', { headers: { authorization: 'Bearer ' + secret }, signal: controller && controller.signal });
    } else if (service === 'helius') {
      response = await fetchImpl('https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(secret), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: controller && controller.signal
      });
    } else if (service === 'stripe') {
      response = await fetchImpl('https://api.stripe.com/v1/balance', { headers: { authorization: 'Bearer ' + secret }, signal: controller && controller.signal });
    } else {
      const origin = safeBase(base);
      if (!origin) return { ok: false, error: 'Use a public https address.' };
      response = await fetchImpl(origin + '/', { headers: { authorization: 'Bearer ' + secret }, signal: controller && controller.signal });
    }
    if (!response || !response.ok) return { ok: false, error: plainError(response && response.status) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: 'That service did not answer.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publicRow(row) {
  return {
    id: row.id,
    service: row.service,
    label: SERVICES[row.service] || row.service,
    baseUrl: row.base_url || '',
    last4: row.last4 || '',
    status: row.status || 'saved'
  };
}

async function handleConnections(req, env, fetchImpl) {
  if (!req || (req.method !== 'GET' && req.method !== 'POST')) return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (token.startsWith('valos_')) {
    const site = publicSupabase();
    const response = await fetchImpl(site.url + '/rest/v1/rpc/valos_key_status', rest(site, site.key, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: token })
    }));
    if (!response || !response.ok) return { status: 401, body: { error: 'Sign-in required.' } };
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.last4) return { status: 401, body: { error: 'Sign-in required.' } };
    return { status: 200, body: { ok: true, last4: row.last4 } };
  }
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  let user;
  try { user = await verifyUser(token, fetchImpl); }
  catch (error) { return { status: 401, body: { error: 'Sign-in required.' } }; }
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  const site = publicSupabase();
  const key = keyBytes(env);
  let payload = {};
  if (req.method === 'POST') {
    try { payload = JSON.parse(req.body || '{}'); }
    catch (error) { return { status: 400, body: { error: 'The request was not understood.' } }; }
  }
  const action = req.method === 'GET' ? 'list' : String(payload.action || '');

  if (action === 'list') {
    const response = await fetchImpl(site.url + '/rest/v1/connections?user_id=eq.' + encodeURIComponent(user.id) + '&select=id,service,base_url,last4,status', rest(site, token));
    const packs = await fetchImpl(site.url + '/rest/v1/connection_packs?user_id=eq.' + encodeURIComponent(user.id) + '&select=paper_only,assistant,status_board', rest(site, token));
    const keys = await fetchImpl(site.url + '/rest/v1/valos_api_keys?user_id=eq.' + encodeURIComponent(user.id) + '&select=id,last4', rest(site, token));
    const rows = response && response.ok ? await response.json() : [];
    const packRows = packs && packs.ok ? await packs.json() : [];
    const keyRows = keys && keys.ok ? await keys.json() : [];
    return {
      status: 200,
      body: {
        connections: (Array.isArray(rows) ? rows : []).map(publicRow),
        packs: packRows[0] || { paper_only: true, assistant: false, status_board: false },
        keys: (Array.isArray(keyRows) ? keyRows : []).map(function (row) { return { id: row.id, last4: row.last4 }; })
      }
    };
  }

  if (action === 'test' || action === 'save') {
    const service = String(payload.service || '');
    if (!SERVICES[service]) return { status: 400, body: { error: 'Choose a listed service.' } };
    let secret = String(payload.key || '');
    if (!secret && payload.id) {
      if (!key) return { status: 503, body: { error: 'Connections not configured' } };
      const loaded = await fetchImpl(site.url + '/rest/v1/connections?id=eq.' + encodeURIComponent(payload.id) + '&user_id=eq.' + encodeURIComponent(user.id) + '&select=ciphertext,service,base_url', rest(site, token));
      const rows = loaded && loaded.ok ? await loaded.json() : [];
      if (!rows[0]) return { status: 404, body: { error: 'That connection was not found.' } };
      try { secret = decryptSecret(rows[0].ciphertext, key); }
      catch (error) { return { status: 400, body: { error: 'That saved key could not be read.' } }; }
    }
    if (service === 'custom' && !safeBase(payload.baseUrl) && action === 'save') {
      return { status: 400, body: { error: 'Use a public https address.' } };
    }
    if (!secret) return { status: 400, body: { error: 'Paste a key first.' } };
    const result = await ping(service, secret, payload.baseUrl, fetchImpl);
    if (action === 'test') {
      return { status: result.ok ? 200 : 400, body: result.ok ? { ok: true } : { error: result.error } };
    }
    if (!key) return { status: 503, body: { error: 'Connections not configured' } };
    const saved = await fetchImpl(site.url + '/rest/v1/connections?select=id,service,base_url,last4,status', rest(site, token, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        service: service,
        base_url: service === 'custom' ? safeBase(payload.baseUrl) : '',
        last4: last4(secret),
        ciphertext: encryptSecret(secret, key),
        status: result.ok ? 'ok' : 'error'
      })
    }));
    if (!saved || !saved.ok) return { status: 502, body: { error: 'The key was not saved.' } };
    const rows = await saved.json();
    const body = { connection: publicRow(rows[0] || {}), error: result.ok ? '' : result.error };
    if (JSON.stringify(body).includes(secret)) return { status: 502, body: { error: 'The key was not saved.' } };
    return { status: 200, body: body };
  }

  if (action === 'delete') {
    const response = await fetchImpl(site.url + '/rest/v1/connections?id=eq.' + encodeURIComponent(payload.id || '') + '&user_id=eq.' + encodeURIComponent(user.id), rest(site, token, '', { method: 'DELETE' }));
    if (!response || !response.ok) return { status: 502, body: { error: 'That connection was not removed.' } };
    return { status: 200, body: { ok: true } };
  }

  if (action === 'packs') {
    const response = await fetchImpl(site.url + '/rest/v1/connection_packs?select=paper_only,assistant,status_board', rest(site, token, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        paper_only: payload.paperOnly !== false,
        assistant: payload.assistant === true,
        status_board: payload.statusBoard === true
      })
    }));
    if (!response || !response.ok) return { status: 502, body: { error: 'Those choices were not saved.' } };
    const rows = await response.json();
    return { status: 200, body: { packs: rows[0] || {} } };
  }

  if (action === 'mint') {
    const fresh = 'valos_' + crypto.randomBytes(24).toString('base64url');
    const response = await fetchImpl(site.url + '/rest/v1/valos_api_keys?select=id,last4', rest(site, token, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ user_id: user.id, last4: last4(fresh), key_hash: hashKey(fresh) })
    }));
    if (!response || !response.ok) return { status: 502, body: { error: 'A key was not created.' } };
    const rows = await response.json();
    return {
      status: 200,
      body: {
        key: fresh,
        last4: rows[0] && rows[0].last4,
        curl: 'curl -s https://valhalla-app.xyz/api/connections -H "Authorization: Bearer ' + fresh + '"'
      }
    };
  }

  return { status: 400, body: { error: 'The request was not understood.' } };
}

module.exports = {
  encryptSecret: encryptSecret,
  decryptSecret: decryptSecret,
  hashKey: hashKey,
  handleConnections: handleConnections,
  SERVICES: SERVICES
};
