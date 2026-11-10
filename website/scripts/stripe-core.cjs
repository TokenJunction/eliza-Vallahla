'use strict';

const crypto = require('node:crypto');
const { publicSupabase } = require('./feed-core.cjs');

const LOOKUP_KEY = 'valos_pro_monthly';
const TRIAL_DAYS = 7;

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
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

async function stripeRequest(secret, method, path, params, fetchImpl, idempotency) {
  const headers = { authorization: 'Bearer ' + secret };
  const init = { method: method, headers: headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params || {}).toString();
  }
  if (idempotency) headers['idempotency-key'] = idempotency;
  const response = await fetchImpl('https://api.stripe.com/v1/' + path, init);
  const body = await response.json();
  return { ok: !!(response && response.ok), status: response && response.status, body: body };
}

function testKey(secret) {
  return String(secret || '').indexOf('sk_test_') === 0;
}

function returnOrigin(headers) {
  const origin = String(headers && (headers.origin || headers.Origin) || '');
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const allowed = url.protocol === 'https:' && (host === 'valhalla-app.xyz' || host === 'www.valhalla-app.xyz' || host.endsWith('.vercel.app'));
    if (allowed) return url.origin;
  } catch (error) { /* use the production desk */ }
  return 'https://valhalla-app.xyz';
}

async function loadEntitlement(user, token, fetchImpl) {
  const site = publicSupabase();
  const response = await fetchImpl(
    site.url + '/rest/v1/entitlements?id=eq.' + encodeURIComponent(user.id) + '&select=trial_used,plan,status,stripe_customer_id',
    { headers: { authorization: 'Bearer ' + token, apikey: site.key, accept: 'application/json' } }
  );
  if (!response || !response.ok) return null;
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function handleCheckout(req, env, fetchImpl) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  let user;
  try { user = await verifyUser(token, fetchImpl); }
  catch (error) { return { status: 401, body: { error: 'Sign-in required.' } }; }
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  const secret = String(env && env.STRIPE_SECRET_KEY || '');
  if (!secret || !testKey(secret)) return { status: 503, body: { error: 'Checkout not configured' } };
  const current = await loadEntitlement(user, token, fetchImpl);
  if (current && current.plan === 'pro' && (current.status === 'active' || current.status === 'trialing')) {
    return { status: 409, body: { error: 'Pro is already on.' } };
  }
  const prices = await stripeRequest(secret, 'GET', 'prices?lookup_keys[]=' + encodeURIComponent(LOOKUP_KEY) + '&active=true&limit=1', null, fetchImpl);
  const price = prices.ok && prices.body && prices.body.data && prices.body.data[0];
  if (!price || !price.id) return { status: 503, body: { error: 'Pro price is not configured.' } };
  const home = returnOrigin(req.headers);
  const params = {
    mode: 'subscription',
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    client_reference_id: user.id,
    'metadata[user_id]': user.id,
    'subscription_data[metadata][user_id]': user.id,
    success_url: home + '/os/?checkout=success',
    cancel_url: home + '/os/?checkout=cancel'
  };
  if (current && current.stripe_customer_id) params.customer = current.stripe_customer_id;
  else if (user.email) params.customer_email = user.email;
  if (!current || current.trial_used !== true) params['subscription_data[trial_period_days]'] = String(TRIAL_DAYS);
  const session = await stripeRequest(secret, 'POST', 'checkout/sessions', params, fetchImpl);
  if (!session.ok || !session.body || !session.body.url) return { status: 502, body: { error: 'Checkout could not be started.' } };
  return { status: 200, body: { url: session.body.url } };
}

function verifyStripeSignature(payload, header, secret, now) {
  if (!payload || !header || !secret) return false;
  const fields = {};
  String(header).split(',').forEach(function (part) {
    const cut = part.indexOf('=');
    if (cut > 0) fields[part.slice(0, cut)] = part.slice(cut + 1);
  });
  const stamp = Number(fields.t);
  const current = Math.floor((now || Date.now()) / 1000);
  if (!fields.v1 || !Number.isFinite(stamp) || Math.abs(current - stamp) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(fields.t + '.' + payload).digest('hex');
  const given = Buffer.from(fields.v1);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

async function cardCheck(secret, session, subscription, fetchImpl) {
  if (!session || !session.customer || !subscription) return false;
  const method = subscription.default_payment_method;
  if (!method) return false;
  const intent = await stripeRequest(secret, 'POST', 'payment_intents', {
    amount: '100',
    currency: 'usd',
    capture_method: 'manual',
    customer: session.customer,
    payment_method: typeof method === 'string' ? method : method.id,
    confirm: 'true',
    off_session: 'true',
    description: 'Card check'
  }, fetchImpl, 'card-check-' + session.id);
  if (!intent.ok || !intent.body) return false;
  if (intent.body.status === 'canceled') return true;
  if (intent.body.status !== 'requires_capture') return false;
  const cancelled = await stripeRequest(secret, 'POST', 'payment_intents/' + encodeURIComponent(intent.body.id) + '/cancel', {}, fetchImpl);
  return !!(cancelled.ok && cancelled.body && cancelled.body.status === 'canceled');
}

async function writeEntitlement(env, row, fetchImpl) {
  const site = publicSupabase();
  const key = String(env && env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!site.url || !key) return false;
  const response = await fetchImpl(site.url + '/rest/v1/entitlements', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      apikey: key,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });
  return !!(response && response.ok);
}

async function handleWebhook(req, env, fetchImpl) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const secret = String(env && env.STRIPE_WEBHOOK_SECRET || '');
  if (!secret) return { status: 503, body: { error: 'Webhook not configured' } };
  if (!String(env && env.SUPABASE_SERVICE_ROLE_KEY || '')) return { status: 503, body: { error: 'Entitlement store not configured' } };
  const header = req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature']);
  if (!verifyStripeSignature(req.body, header, secret)) return { status: 400, body: { error: 'Invalid signature.' } };
  let event;
  try { event = JSON.parse(req.body); }
  catch (error) { return { status: 400, body: { error: 'Invalid payload.' } }; }
  const object = event && event.data && event.data.object;
  if (!object) return { status: 400, body: { error: 'Invalid payload.' } };
  const stripeKey = testKey(env.STRIPE_SECRET_KEY) ? String(env.STRIPE_SECRET_KEY) : '';
  if (event.type === 'checkout.session.completed') {
    let needsCard = true;
    let subStatus = 'active';
    if (stripeKey && object.subscription) {
      try {
        const subscription = await stripeRequest(stripeKey, 'GET', 'subscriptions/' + encodeURIComponent(object.subscription), null, fetchImpl);
        const body = subscription.ok && subscription.body;
        if (body && body.status) subStatus = body.status;
        needsCard = !(await cardCheck(stripeKey, object, body, fetchImpl));
      } catch (error) { needsCard = true; }
    }
    const saved = await writeEntitlement(env, {
      id: object.client_reference_id || (object.metadata && object.metadata.user_id),
      plan: 'pro',
      status: subStatus === 'trialing' ? 'trialing' : 'active',
      trial_used: true,
      needs_card: needsCard,
      stripe_customer_id: object.customer || null,
      stripe_subscription_id: object.subscription || null
    }, fetchImpl);
    if (!saved) return { status: 502, body: { error: 'Entitlement was not saved.' } };
    return { status: 200, body: { received: true } };
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
    const ended = event.type === 'customer.subscription.deleted';
    const failed = event.type === 'invoice.payment_failed';
    const isSub = event.type.indexOf('customer.subscription.') === 0;
    let userId = object.metadata && object.metadata.user_id || object.client_reference_id;
    if (!userId && object.subscription && stripeKey) {
      const subscription = await stripeRequest(stripeKey, 'GET', 'subscriptions/' + encodeURIComponent(object.subscription), null, fetchImpl);
      userId = subscription.ok && subscription.body && subscription.body.metadata && subscription.body.metadata.user_id;
    }
    if (!userId) return { status: 200, body: { received: true } };
    const saved = await writeEntitlement(env, {
      id: userId,
      plan: ended ? 'free' : 'pro',
      status: ended ? 'canceled' : (failed ? 'past_due' : (object.status || 'active')),
      stripe_customer_id: object.customer || null,
      stripe_subscription_id: isSub ? object.id : (object.subscription || null)
    }, fetchImpl);
    if (!saved) return { status: 502, body: { error: 'Entitlement was not saved.' } };
    return { status: 200, body: { received: true } };
  }
  return { status: 200, body: { received: true } };
}

module.exports = {
  LOOKUP_KEY: LOOKUP_KEY,
  handleCheckout: handleCheckout,
  handleWebhook: handleWebhook,
  verifyStripeSignature: verifyStripeSignature
};
