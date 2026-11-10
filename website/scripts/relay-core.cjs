'use strict';

const crypto = require('node:crypto');
const { publicSupabase } = require('./feed-core.cjs');

const MAX_SKEW_MS = 5 * 60 * 1000;
const seen = new Set();

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function raw(value) {
  return Buffer.from(String(value || ''), 'base64');
}

function derive(shared, nonce) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, nonce, 'valos-relay', 32));
}

function transcript(packet) {
  return Buffer.from([packet.from, packet.to, String(packet.ts), packet.nonce, packet.eph, packet.iv, packet.tag, packet.box].join('.'));
}

function sealPackage(payload, opts) {
  const eph = crypto.generateKeyPairSync('x25519');
  const nonce = crypto.randomBytes(16);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: opts.agreePublic });
  const key = derive(shared, nonce);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const box = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packet = {
    from: opts.from,
    to: opts.to,
    ts: opts.now || Date.now(),
    nonce: b64(nonce),
    eph: b64(eph.publicKey.export({ type: 'spki', format: 'der' })),
    iv: b64(iv),
    tag: b64(tag),
    box: b64(box)
  };
  packet.sig = b64(crypto.sign(null, transcript(packet), opts.signPrivate));
  return packet;
}

function openPackage(packet, opts) {
  if (!packet || !packet.sig || !packet.box) return { ok: false, error: 'The package was refused.' };
  const now = opts.now || Date.now();
  const skew = Math.abs(now - Number(packet.ts || 0));
  if (!Number.isFinite(Number(packet.ts)) || skew > MAX_SKEW_MS) return { ok: false, error: 'That package is too old.' };
  const id = packet.from + ':' + packet.nonce;
  if (opts.seen && opts.seen.has(id)) return { ok: false, error: 'That package was already seen.' };
  const signPublic = opts.signPublics && opts.signPublics[packet.from];
  if (!signPublic) return { ok: false, error: 'The package was refused.' };
  const valid = crypto.verify(null, transcript(packet), signPublic, raw(packet.sig));
  if (!valid) return { ok: false, error: 'The package was refused.' };
  try {
    const eph = crypto.createPublicKey({ key: raw(packet.eph), type: 'spki', format: 'der' });
    const shared = crypto.diffieHellman({ privateKey: opts.agreePrivate, publicKey: eph });
    const key = derive(shared, raw(packet.nonce));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw(packet.iv));
    decipher.setAuthTag(raw(packet.tag));
    const text = Buffer.concat([decipher.update(raw(packet.box)), decipher.final()]).toString('utf8');
    if (opts.seen) opts.seen.add(id);
    return { ok: true, payload: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: 'The package was refused.' };
  }
}

function sealSnapshot(doc, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function openSnapshot(packed, key) {
  const buf = Buffer.from(String(packed), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

function backupKey(env) {
  const key = Buffer.from(String(env && env.BACKUP_ENC_KEY || ''), 'base64');
  return key.length === 32 ? key : null;
}

function publicSnapshot(env, health) {
  return {
    at: new Date().toISOString(),
    health: health || 'Overseer not connected',
    config: { site: 'valhalla-app.xyz' }
  };
}

function resetRelay() {
  seen.clear();
}

function nodeKeys(env) {
  try {
    return {
      id: String(env.RELAY_NODE_ID || ''),
      signPrivate: env.RELAY_SIGN_PRIVATE ? crypto.createPrivateKey(env.RELAY_SIGN_PRIVATE) : null,
      agreePrivate: env.RELAY_AGREE_PRIVATE ? crypto.createPrivateKey(env.RELAY_AGREE_PRIVATE) : null,
      peers: JSON.parse(env.RELAY_PEERS || '{}')
    };
  } catch (error) {
    return null;
  }
}

function peerPublics(peers) {
  const out = {};
  Object.keys(peers || {}).forEach(function (id) {
    if (peers[id] && peers[id].sign) out[id] = crypto.createPublicKey(peers[id].sign);
  });
  return out;
}

async function handleRelay(req, env, fetchImpl) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const keys = nodeKeys(env);
  if (!keys || !keys.agreePrivate) return { status: 503, body: { error: 'Relay not configured' } };
  let packet;
  try { packet = JSON.parse(req.body || ''); }
  catch (error) { return { status: 400, body: { error: 'The package was refused.' } }; }
  const opened = openPackage(packet, { agreePrivate: keys.agreePrivate, signPublics: peerPublics(keys.peers), seen: seen, now: Date.now() });
  if (!opened.ok) return { status: 400, body: { error: opened.error } };
  return { status: 200, body: { ok: true, payload: opened.payload } };
}

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

async function adminUser(req, env, fetchImpl) {
  const token = bearer(req.headers);
  const allow = String(env.ADMIN_USER_IDS || '').split(',').map(function (item) { return item.trim(); }).filter(Boolean);
  if (!token || !allow.length) return null;
  const site = publicSupabase();
  const response = await fetchImpl(site.url + '/auth/v1/user', { headers: { authorization: 'Bearer ' + token, apikey: site.key } });
  if (!response || !response.ok) return null;
  const user = await response.json();
  return user && allow.indexOf(user.id) !== -1 ? user : null;
}

async function handleSnapshot(req, env, fetchImpl) {
  const cron = bearer(req.headers) && env.CRON_SECRET && bearer(req.headers) === env.CRON_SECRET;
  const admin = cron ? { id: 'cron' } : await adminUser(req, env, fetchImpl);
  if (!admin) return { status: 404, body: { error: 'Not found.' } };
  const key = backupKey(env);
  if (!key) return { status: 503, body: { error: 'Backup not configured' } };
  let payload = {};
  try { payload = JSON.parse(req.body || '{}'); }
  catch (error) { payload = {}; }
  if (!cron && payload.action === 'ping') return { status: 200, body: { ok: true } };
  if (!cron && payload.action === 'restore') {
    const packed = payload.packed || await latestBackup(env, fetchImpl);
    if (!packed) return { status: 400, body: { error: 'Nothing is stored to restore.' } };
    try {
      return { status: 200, body: { restored: openSnapshot(packed, key) } };
    } catch (error) {
      return { status: 400, body: { error: 'That backup could not be read.' } };
    }
  }
  const doc = publicSnapshot(env, payload.health || 'Overseer not connected');
  const packed = sealSnapshot(doc, key);
  const stored = await storeBackup(env, packed, fetchImpl);
  if (!stored) return { status: 503, body: { error: 'Backup storage not configured', packed: packed, at: doc.at, stored: false } };
  return { status: 200, body: { packed: packed, at: doc.at, stored: true } };
}

async function storeBackup(env, packed, fetchImpl) {
  const secret = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  const site = publicSupabase();
  if (!secret || !site.url) return false;
  const response = await fetchImpl(site.url + '/storage/v1/object/overseer-backups/snapshot-' + Date.now() + '.txt', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, apikey: secret, 'content-type': 'text/plain' },
    body: packed
  });
  return !!(response && response.ok);
}

async function latestBackup(env, fetchImpl) {
  const secret = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  const site = publicSupabase();
  if (!secret || !site.url) return '';
  const list = await fetchImpl(site.url + '/storage/v1/object/list/overseer-backups', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, apikey: secret, 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: 'snapshot-', limit: 1, sortBy: { column: 'name', order: 'desc' } })
  });
  const rows = list && list.ok ? await list.json() : [];
  const name = rows && rows[0] && rows[0].name;
  if (!name) return '';
  const file = await fetchImpl(site.url + '/storage/v1/object/overseer-backups/' + encodeURIComponent(name), {
    headers: { authorization: 'Bearer ' + secret, apikey: secret }
  });
  if (!file || !file.ok) return '';
  return typeof file.text === 'function' ? file.text() : '';
}

module.exports = {
  sealPackage: sealPackage,
  openPackage: openPackage,
  sealSnapshot: sealSnapshot,
  openSnapshot: openSnapshot,
  handleRelay: handleRelay,
  handleSnapshot: handleSnapshot,
  resetRelay: resetRelay,
  publicSnapshot: publicSnapshot
};
