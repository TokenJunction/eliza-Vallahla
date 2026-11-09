const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/settings.js'), 'utf8');

function storage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => data[key] ?? null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; },
    clear: () => { Object.keys(data).forEach(key => delete data[key]); }
  };
}

function fixture({ status = 200, token = 'live-token' } = {}) {
  const now = Date.now();
  const localStorage = storage({
    'valhalla-session': JSON.stringify({ kind: 'account', at: now }),
    'valhalla-watch': 'wallet'
  });
  const sessionStorage = storage(token ? { 'valhalla-auth-token': token } : {});
  const nodes = {};
  const calls = [];
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, hidden: true, value: '', checked: false, textContent: '', dataset: {},
        handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }
      };
    }
    return nodes[id];
  }
  const document = {
    body: { dataset: {}, classList: { toggle() {} } },
    getElementById: node
  };
  const location = { href: '' };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: status === 200, status };
  };
  vm.runInNewContext(source, {
    window: { VALHALLA_SITE: { AUTH_URL: 'https://auth.example.test' } },
    document, location, localStorage, sessionStorage, fetch, Date, JSON, String,
    Event: function (type) { this.type = type; }
  });
  return { node, location, localStorage, sessionStorage, calls };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('sign out revokes the server session before clearing the local bearer and session', async () => {
  const f = fixture();
  f.node('signOut').handlers.click();
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://auth.example.test/auth/logout');
  assert.equal(f.calls[0].options.credentials, 'include');
  assert.ok(f.calls[0].options.headers.authorization.startsWith('Bearer '));
  assert.equal(f.calls[0].options.body, '{}');
  assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), null);
  assert.equal(f.localStorage.getItem('valhalla-session'), null);
  assert.equal(f.location.href, '/app/');
});

test('failed remote revocation does not claim logout or clear the active session', async () => {
  const f = fixture({ status: 503 });
  f.node('signOut').handlers.click();
  await flush();
  assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), 'live-token');
  assert.notEqual(f.localStorage.getItem('valhalla-session'), null);
  assert.match(f.node('signOutNote').textContent, /still signed in/);
  assert.equal(f.location.href, '');
});

test('paper desk sign out clears local demo state without calling auth service', () => {
  const f = fixture({ token: '' });
  f.node('signOut').handlers.click();
  assert.equal(f.calls.length, 0);
  assert.equal(f.localStorage.getItem('valhalla-session'), null);
  assert.equal(f.location.href, '/app/');
});
