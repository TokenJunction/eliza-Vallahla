'use strict';

const crypto = require('node:crypto');
const { publicSupabase } = require('./feed-core.cjs');

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function vapid(env) {
  const publicKey = String(env && env.VAPID_PUBLIC_KEY || '');
  const privateKey = String(env && env.VAPID_PRIVATE_KEY || '');
  const subject = String(env && env.VAPID_SUBJECT || '');
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey: publicKey, privateKey: privateKey, subject: subject };
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

function service(env) {
  const site = publicSupabase();
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!site.url || !key) return null;
  return { url: site.url, key: key };
}

async function handlePush(req, env, fetchImpl, webPush) {
  if (!req || req.method === 'GET') {
    const keys = vapid(env);
    if (!keys) return { status: 503, body: { error: 'Push not configured' } };
    return { status: 200, body: { publicKey: keys.publicKey } };
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  const user = await verifyUser(token, fetchImpl);
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  const store = service(env);
  const keys = vapid(env);
  if (!store || !keys) return { status: 503, body: { error: 'Push not configured' } };
  let payload = {};
  try { payload = JSON.parse(req.body || '{}'); }
  catch (error) { return { status: 400, body: { error: 'The request was not understood.' } }; }
  const sub = payload.subscription || {};
  if (payload.action === 'unsubscribe') {
    await fetchImpl(store.url + '/rest/v1/push_subscriptions?user_id=eq.' + encodeURIComponent(user.id) + '&endpoint=eq.' + encodeURIComponent(sub.endpoint || ''), {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + store.key, apikey: store.key }
    });
    return { status: 200, body: { ok: true } };
  }
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { status: 400, body: { error: 'A push subscription is required.' } };
  }
  const saved = await fetchImpl(store.url + '/rest/v1/push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + store.key,
      apikey: store.key,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ user_id: user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  });
  if (!saved || !saved.ok) return { status: 502, body: { error: 'The subscription was not saved.' } };
  const encoded = JSON.stringify({ ok: true });
  if (encoded.includes(keys.privateKey)) return { status: 502, body: { error: 'The subscription was not saved.' } };
  return { status: 200, body: { ok: true } };
}

async function notifyUsers(env, fetchImpl, message, webPush) {
  const keys = vapid(env);
  const store = service(env);
  if (!keys || !store) return { sent: 0, configured: false };
  const list = await fetchImpl(store.url + '/rest/v1/push_subscriptions?select=endpoint,p256dh,auth', {
    headers: { authorization: 'Bearer ' + store.key, apikey: store.key, accept: 'application/json' }
  });
  const rows = list && list.ok ? await list.json() : [];
  const sender = webPush || require('web-push');
  sender.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  let sent = 0;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    try {
      await sender.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      }, JSON.stringify(message));
      sent += 1;
    } catch (error) {
      /* one bad subscription does not stop the rest */
    }
  }
  return { sent: sent, configured: true };
}

function signed(raw, header, secret) {
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const left = Buffer.from(String(header));
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function sendAdminEmail(env, fetchImpl, text) {
  const key = String(env && env.RESEND_API_KEY || '');
  const to = String(env && env.ADMIN_EMAIL || '');
  const from = String(env && env.RESEND_FROM || '');
  if (!key || !to || !from) return { sent: false, error: 'Email not configured' };
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ from: from, to: to, subject: 'Overseer alert', text: text })
  });
  return { sent: !!(response && response.ok) };
}

async function handleCallback(req, env, fetchImpl, webPush) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const secret = String(env && env.CALLBACK_HOOK_SECRET || '');
  if (!secret) return { status: 503, body: { error: 'Callback not configured' } };
  const header = req.headers && (req.headers['x-callback-signature'] || req.headers['X-Callback-Signature']);
  if (!signed(req.body || '', header, secret)) return { status: 401, body: { error: 'The signature was rejected.' } };
  let payload = {};
  try { payload = JSON.parse(req.body || '{}'); }
  catch (error) { return { status: 400, body: { error: 'The request was not understood.' } }; }
  const text = 'Call-back request. ' + String(payload.note || 'A caller asked for a call back.');
  const push = await notifyUsers(env, fetchImpl, { title: 'Call back', body: text }, webPush);
  const email = await sendAdminEmail(env, fetchImpl, text);
  return { status: 200, body: { ok: true, push: push.sent, email: email.sent } };
}

function allowlist(env) {
  return String(env && env.ADMIN_USER_IDS || '').split(',').map(function (item) { return item.trim(); }).filter(Boolean);
}

async function handleOwnerAction(req, env, fetchImpl) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 404, body: { error: 'Not found.' } };
  const user = await verifyUser(token, fetchImpl);
  if (!user || allowlist(env).indexOf(user.id) === -1) return { status: 404, body: { error: 'Not found.' } };
  let payload = {};
  try { payload = JSON.parse(req.body || '{}'); }
  catch (error) { return { status: 400, body: { error: 'The request was not understood.' } }; }
  if (payload.action === 'ping') return { status: 200, body: { ok: true } };
  if (payload.action !== 'ship' && payload.action !== 'undo') return { status: 400, body: { error: 'The request was not understood.' } };
  if (!env.GITHUB_PUSH_TOKEN && payload.action === 'ship') return { status: 503, body: { error: 'Push agent not configured' } };
  if (!env.VERCEL_TOKEN && payload.action === 'undo') return { status: 503, body: { error: 'Push agent not configured' } };
  return { status: 200, body: { ok: true, action: payload.action, executed: false } };
}

module.exports = {
  handlePush: handlePush,
  handleCallback: handleCallback,
  handleOwnerAction: handleOwnerAction,
  notifyUsers: notifyUsers,
  signed: signed
};
