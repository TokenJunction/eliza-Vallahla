const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { handleCheckout, handleWebhook, verifyStripeSignature, LOOKUP_KEY } = require('./stripe-core.cjs');

function user(ok) {
  return { ok: ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'user-1', email: 'a@example.com' } : {}) };
}

function sign(payload, secret) {
  const stamp = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', secret).update(stamp + '.' + payload).digest('hex');
  return 't=' + stamp + ',v1=' + v1;
}

test('checkout requires a session and a Stripe key', async () => {
  const missing = await handleCheckout({ method: 'POST', headers: {} }, { STRIPE_SECRET_KEY: 'sk_test_only' }, async () => { throw new Error('no'); });
  assert.equal(missing.status, 401);
  const calls = [];
  const unconfigured = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good' }
  }, {}, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return user(true);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error, 'Checkout not configured');
  assert.equal(calls.some(url => url.includes('api.stripe.com')), false);
});

test('checkout starts a subscription trial for a new user', async () => {
  const calls = [];
  const result = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good' }
  }, { STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    if (String(url).includes('/auth/v1/user')) return user(true);
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => [] };
    if (String(url).includes('lookup_keys')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'price_pro' }] }) };
    return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) };
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.url, 'https://checkout.stripe.com/c/pay/cs_test');
  const created = decodeURIComponent(calls.find(call => call.url.endsWith('/checkout/sessions')).body);
  assert.match(created, /mode=subscription/);
  assert.match(created, /payment_method_collection=always/);
  assert.match(created, /client_reference_id=user-1/);
  assert.match(created, /subscription_data\[trial_period_days\]=7/);
  assert.match(created, /subscription_data\[metadata\]\[user_id\]=user-1/);
  assert.match(created, /success_url=https:\/\/valhalla-app\.xyz\/os\//);
  assert.equal(created.includes('payment_method_types'), false);
  assert.match(calls.find(call => call.url.includes('prices')).url, new RegExp(LOOKUP_KEY));
});

test('a used trial is not offered again', async () => {
  let sessionBody = '';
  const result = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good' }
  }, { STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return user(true);
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => [{ trial_used: true }] };
    if (String(url).includes('lookup_keys')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'price_pro' }] }) };
    sessionBody = init && init.body || '';
    return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) };
  });
  assert.equal(result.status, 200);
  assert.equal(sessionBody.includes('trial_period_days'), false);
});

test('webhook rejects a bad signature and holds then releases one dollar', async () => {
  const secret = 'whsec_test';
  const bad = await handleWebhook({
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=nope' },
    body: '{}'
  }, { STRIPE_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role', STRIPE_SECRET_KEY: 'sk_test_only' }, async () => { throw new Error('no'); });
  assert.equal(bad.status, 400);
  const session = { id: 'cs_test_1', client_reference_id: 'user-1', customer: 'cus_1', subscription: 'sub_1' };
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } });
  const calls = [];
  const ok = await handleWebhook({
    method: 'POST',
    headers: { 'stripe-signature': sign(payload, secret) },
    body: payload
  }, { STRIPE_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role', STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    calls.push({ url: String(url), body: init && init.body, headers: init && init.headers });
    if (String(url).includes('/subscriptions/')) return { ok: true, status: 200, json: async () => ({ default_payment_method: 'pm_1' }) };
    if (String(url).endsWith('/payment_intents')) return { ok: true, status: 200, json: async () => ({ id: 'pi_1', status: 'requires_capture' }) };
    if (String(url).endsWith('/cancel')) return { ok: true, status: 200, json: async () => ({ id: 'pi_1', status: 'canceled' }) };
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 500, json: async () => ({}) };
  });
  assert.equal(ok.status, 200);
  const hold = calls.find(call => String(call.url).endsWith('/payment_intents'));
  assert.match(hold.body, /amount=100/);
  assert.match(hold.body, /capture_method=manual/);
  assert.equal(hold.headers['idempotency-key'], 'card-check-cs_test_1');
  assert.equal(calls.some(call => String(call.url).endsWith('/cancel')), true);
  const saved = JSON.parse(calls.find(call => String(call.url).includes('/entitlements')).body);
  assert.equal(saved.needs_card, false);
  assert.equal(saved.trial_used, true);
  assert.equal(saved.plan, 'pro');
  assert.equal(JSON.stringify(ok.body).includes('service-role'), false);
  assert.equal(verifyStripeSignature(payload, sign(payload, secret), secret), true);
});

test('a live Stripe key is refused', async () => {
  const calls = [];
  const result = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good', origin: 'https://www.valhalla-app.xyz' }
  }, { STRIPE_SECRET_KEY: 'sk_live_refused' }, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return user(true);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(result.status, 503);
  assert.equal(calls.some(url => url.includes('api.stripe.com')), false);
});

test('checkout returns to the calling site and skips a second subscription', async () => {
  let sessionBody = '';
  const again = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good', origin: 'https://www.valhalla-app.xyz' }
  }, { STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return user(true);
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => [{ plan: 'pro', status: 'active', trial_used: true, stripe_customer_id: 'cus_9' }] };
    sessionBody = init && init.body || '';
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(again.status, 409);
  assert.equal(sessionBody, '');
  const fresh = await handleCheckout({
    method: 'POST',
    headers: { authorization: 'Bearer good', origin: 'https://preview.vercel.app' }
  }, { STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    if (String(url).includes('/auth/v1/user')) return user(true);
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => [{ trial_used: true, stripe_customer_id: 'cus_9' }] };
    if (String(url).includes('lookup_keys')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'price_pro' }] }) };
    sessionBody = init && init.body || '';
    return { ok: true, status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' }) };
  });
  assert.equal(fresh.status, 200);
  const created = decodeURIComponent(sessionBody);
  assert.match(created, /success_url=https:\/\/preview\.vercel\.app\/os\//);
  assert.match(created, /customer=cus_9/);
  assert.equal(created.includes('trial_period_days'), false);
});

test('an old webhook and a canceled card check stay honest', async () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_old', client_reference_id: 'user-1', customer: 'cus_1', subscription: 'sub_1' } } });
  const old = await handleWebhook({
    method: 'POST',
    headers: { 'stripe-signature': sign(payload, secret).replace(/t=\d+/, 't=1') },
    body: payload
  }, { STRIPE_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role', STRIPE_SECRET_KEY: 'sk_test_only' }, async () => { throw new Error('no'); });
  assert.equal(old.status, 400);
  const calls = [];
  const paid = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_paid', client_reference_id: 'user-1', customer: 'cus_1', subscription: 'sub_1' } } });
  const result = await handleWebhook({
    method: 'POST',
    headers: { 'stripe-signature': sign(paid, secret) },
    body: paid
  }, { STRIPE_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role', STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    if (String(url).includes('/subscriptions/')) return { ok: true, status: 200, json: async () => ({ status: 'active', default_payment_method: 'pm_1' }) };
    if (String(url).endsWith('/payment_intents')) return { ok: true, status: 200, json: async () => ({ id: 'pi_1', status: 'canceled' }) };
    if (String(url).includes('/entitlements')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 500, json: async () => ({}) };
  });
  assert.equal(result.status, 200);
  assert.equal(calls.some(call => call.url.endsWith('/cancel')), false);
  const saved = JSON.parse(calls.find(call => call.url.includes('/entitlements')).body);
  assert.equal(saved.status, 'active');
  assert.equal(saved.needs_card, false);
});

test('subscription updates keep the user id', async () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { user_id: '11111111-1111-1111-1111-111111111111' } } }
  });
  let saved = null;
  const result = await handleWebhook({
    method: 'POST',
    headers: { 'stripe-signature': sign(payload, secret) },
    body: payload
  }, { STRIPE_WEBHOOK_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: 'service-role', STRIPE_SECRET_KEY: 'sk_test_only' }, async (url, init) => {
    if (String(url).includes('/entitlements')) saved = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(result.status, 200);
  assert.equal(saved.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(saved.plan, 'free');
  assert.equal(saved.status, 'canceled');
  assert.equal(saved.stripe_subscription_id, 'sub_1');
});

test('the desk explains the one dollar hold', () => {
  const html = fs.readFileSync(path.join(__dirname, '../os/index.html'), 'utf8');
  assert.match(html, /Start 7-day free trial/);
  assert.match(html, /A \$1 hold verifies your card and is released right away/);
  assert.match(html, /Pro is \$12 a month unless you cancel/);
});
