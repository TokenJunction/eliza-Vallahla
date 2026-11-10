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

async function trialAlreadyUsed(user, token, fetchImpl) {
  const site = publicSupabase();
  const response = await fetchImpl(
    site.url + '/rest/v1/entitlements?id=eq.' + encodeURIComponent(user.id) + '&select=trial_used',
    { headers: { authorization: 'Bearer ' + token, apikey: site.key, accept: 'application/json' } }
  );
  if (!response || !response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.some(function (row) { return row && row.trial_used === true; });
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
  if (!secret) return { status: 503, body: { error: 'Checkout not configured' } };
  const prices = await stripeRequest(secret, 'GET', 'prices?lookup_keys[]=' + encodeURIComponent(LOOKUP_KEY) + '&active=true&limit=1', null, fetchImpl);
  const price = prices.ok && prices.body && prices.body.data && prices.body.data[0];
  if (!price || !price.id) return { status: 503, body: { error: 'Pro price is not configured.' } };
  const used = await trialAlreadyUsed(user, token, fetchImpl);
  const params = {
    mode: 'subscription',
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    client_reference_id: user.id,
    success_url: 'https://valhalla-app.xyz/os/?checkout=success',
    cancel_url: 'https://valhalla-app.xyz/os/?checkout=cancel'
  };
  if (user.email) params.customer_email = user.email;
  if (!used) params['subscription_data[trial_period_days]'] = String(TRIAL_DAYS);
  const session = await stripeRequest(secret, 'POST', 'checkout/sessions', params, fetchImpl);
  if (!session.ok || !session.body || !session.body.url) return { status: 502, body: { error: 'Checkout could not be started.' } };
  return { status: 200, body: { url: session.body.url } };
}

function verifyStripeSignature(payload, header, secret) {
  if (!payload || !header || !secret) return false;
  const fields = {};
  String(header).split(',').forEach(function (part) {
    const cut = part.indexOf('=');
    if (cut > 0) fields[part.slice(0, cut)] = part.slice(cut + 1);
  });
  if (!fields.t || !fields.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(fields.t + '.' + payload).digest('hex');
  const given = Buffer.from(fields.v1);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

async function cardCheck(secret, session, fetchImpl) {
  if (!session || !session.subscription || !session.customer) return false;
  const subscription = await stripeRequest(secret, 'GET', 'subscriptions/' + encodeURIComponent(session.subscription), null, fetchImpl);
  const method = subscription.ok && subscription.body && subscription.body.default_payment_method;
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
  if (!intent.ok || !intent.body || intent.body.status !== 'requires_capture') return false;
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
  const stripeKey = String(env.STRIPE_SECRET_KEY || '');
  if (event.type === 'checkout.session.completed') {
    let needsCard = true;
    if (stripeKey) {
      try { needsCard = !(await cardCheck(stripeKey, object, fetchImpl)); }
      catch (error) { needsCard = true; }
    }
    const saved = await writeEntitlement(env, {
      id: object.client_reference_id,
      plan: 'pro',
      status: 'trialing',
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
    const userId = object.metadata && object.metadata.user_id || object.client_reference_id;
    if (!userId && event.type === 'invoice.payment_failed') return { status: 200, body: { received: true } };
    const saved = await writeEntitlement(env, {
      id: userId || object.id,
      plan: ended ? 'free' : 'pro',
      status: ended ? 'canceled' : (failed ? 'past_due' : (object.status || 'active')),
      stripe_customer_id: object.customer || null,
      stripe_subscription_id: event.type.indexOf('subscription') === 0 ? object.id : (object.subscription || null)
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
