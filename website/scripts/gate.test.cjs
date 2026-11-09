const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../site-build/app/gate.js'), 'utf8');

function storage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => data[key] ?? null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }
  };
}

function fixture({ restored = false, reject = false, human = true, noToken = false, access = 'valid',
  invalidSession = false, authUrl = 'https://auth.example.test', accessNetworkError = false } = {}) {
  const now = Date.now();
  const localStorage = storage(restored ? {
    'valhalla-account': JSON.stringify({ hint: 'a***@example.test', method: 'email', termsAccepted: true }),
    'valhalla-session': JSON.stringify({ kind: 'account', hint: 'a***@example.test', at: now })
  } : {});
  const sessionStorage = storage({
    ...(human ? { 'valhalla-human': JSON.stringify({ ok: true, at: now }) } : {}),
    'valhalla-terms-session': '2026-11-03',
    ...(restored && !noToken ? { 'valhalla-auth-token': 'fixture-live-token' } : {}),
    ...(restored ? { 'valhalla-auth': '1', 'valhalla-code-ok': '1' } : {})
  });
  const nodes = {}, events = {}, calls = [];
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, hidden: true, dataset: {}, value: '', checked: false, disabled: false,
        parentElement: { clientWidth: 480 }, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; },
        focus() {}, appendChild() {}, setAttribute() {},
        getContext() { return { fillRect() {}, beginPath() {}, arc() {}, fill() {} }; }
      };
    }
    return nodes[id];
  }
  const document = {
    readyState: 'loading',
    getElementById: node,
    querySelector: () => null,
    addEventListener(type, fn) { (events['document:' + type] ||= []).push(fn); },
    createElement: () => node('created'),
    head: { appendChild() {} }
  };
  const window = {
    VALHALLA_SITE: { AUTH_URL: authUrl, TERMS_VERSION: '2026-11-03' },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    setInterval() { return 1; },
    setTimeout() { return 1; },
    location: { assign() {} }
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/access') && accessNetworkError) throw new Error('network unavailable');
    const body = url.endsWith('/auth/access') && access === 'valid'
      ? { ok: true, expires: Date.now() + 60_000, plan: 'free' }
      : url.endsWith('/auth/access') ? { ok: false, error: 'session' }
      : url.endsWith('/auth/nonce') ? { nonce: 'fixture' }
      : url.endsWith('/auth/email/start') ? { ok: true, pending: 'pending', hint: 'a***@example.test' }
        : url.endsWith('/auth/email/verify') ? (reject ? { ok: false, error: 'code' } : { ok: true, hint: 'a***@example.test', session: invalidSession ? '' : 'fixture-session' })
          : {};
    const status = url.endsWith('/auth/access') && access !== 'valid' ? 401 : 200;
    return { ok: status === 200, status, json: async () => body };
  };
  const context = {
    window, document, localStorage, sessionStorage, fetch, Date, Intl, Number, Math,
    Event: function (type) { this.type = type; },
    ValhallaErrors: { show() {} }, location: window.location,
    IntersectionObserver: function () { this.observe = () => {}; }
  };
  vm.runInNewContext(source, context);
  return {
    node, window, localStorage, sessionStorage, calls,
    ready() { for (const fn of events['document:DOMContentLoaded'] || []) fn(); }
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('restored desk requires a server-verified access session', async () => {
  const f = fixture({ restored: true });
  let ready = 0;
  f.window.addEventListener('valhalla-desk', () => { ready++; });
  assert.equal(f.node('desk').hidden, true);
  f.ready();
  await flush();
  assert.equal(f.node('desk').hidden, false);
  assert.equal(ready, 1);
  assert.equal(f.node('modeBadge').textContent, 'READ ONLY');
  const access = f.calls.find(call => call.url.endsWith('/auth/access'));
  assert.ok(access.options.headers.authorization.startsWith('Bearer '));
  assert.equal(access.options.credentials, 'include');
});

test('legacy browser auth flags without a server token do not authorize the desk', async () => {
  const f = fixture({ restored: true, noToken: true });
  f.ready();
  await flush();
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('gateAccount').hidden, false);
  assert.equal(f.calls.some(call => call.url.endsWith('/auth/access')), false);
  assert.equal(f.sessionStorage.getItem('valhalla-auth'), null);
});

test('expired server session clears cached account session and returns to sign in', async () => {
  const f = fixture({ restored: true, access: 'expired' });
  f.ready();
  await flush();
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('gateAccount').hidden, false);
  assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), null);
  assert.equal(f.localStorage.getItem('valhalla-session'), null);
});

test('missing auth configuration and access outages fail closed', async () => {
  for (const options of [{ authUrl: '' }, { accessNetworkError: true }]) {
    const f = fixture({ restored: true, ...options });
    f.ready();
    await flush();
    assert.equal(f.node('desk').hidden, true);
    assert.equal(f.node('mechaError').hidden, false);
    assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), 'fixture-live-token');
  }
});

for (const reject of [false, true]) {
  test(`email verification ${reject ? 'rejection keeps the gate closed' : 'opens and initializes the desk'}`, async () => {
    const f = fixture({ reject });
    let ready = 0;
    f.window.addEventListener('valhalla-desk', () => { ready++; });
    f.ready();
    f.node('magicEmail').value = 'a@example.test';
    f.node('emailForm').handlers.submit({ preventDefault() {} });
    await flush();
    assert.equal(f.node('gateCode').hidden, false);
    f.node('emailCodeInput').value = '123456';
    f.node('codeForm').handlers.submit({ preventDefault() {} });
    await flush();
    await flush();
    assert.equal(f.node('desk').hidden, reject);
    assert.equal(ready, reject ? 0 : 1);
    assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), reject ? null : 'fixture-session');
    assert.equal(f.calls.filter(call => call.url.endsWith('/auth/nonce')).length, 2);
    assert.ok(f.calls.every(call => call.options.credentials === 'include'));
  });
}

test('email verification without a server session keeps the desk closed', async () => {
  const f = fixture({ invalidSession: true });
  f.ready();
  f.node('magicEmail').value = 'a@example.test';
  f.node('emailForm').handlers.submit({ preventDefault() {} });
  await flush();
  f.node('emailCodeInput').value = '123456';
  f.node('codeForm').handlers.submit({ preventDefault() {} });
  await flush();
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('mechaError').hidden, false);
  assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), null);
});

test('missing human-check configuration does not advance the gate', () => {
  const f = fixture({ human: false });
  f.ready();
  assert.equal(f.node('gateHuman').hidden, false);
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('humanPlaceholder').handlers.click, undefined);
});
