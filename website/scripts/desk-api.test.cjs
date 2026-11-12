const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const API = 'https://valhalla-app.xyz';

function element(id) {
  return {
    id: id,
    value: '',
    textContent: '',
    disabled: false,
    hidden: false,
    dataset: {},
    children: [],
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    querySelector() { return element('button'); }
  };
}

function run(file, config, fetchImpl) {
  const nodes = {};
  const windowHandlers = {};
  const document = {
    body: { dataset: { session: 'in', wallet: '' } },
    getElementById(id) { return nodes[id] ||= element(id); },
    createElement(tag) { const node = element(tag); node.tag = tag; return node; }
  };
  const window = {
    VALHALLA_SITE: config,
    ValhallaSupabase: {
      client: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } })
    },
    addEventListener(type, fn) { (windowHandlers[type] ||= []).push(fn); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    document: document,
    window: window,
    fetch: fetchImpl,
    JSON: JSON,
    Date: Date,
    encodeURIComponent: encodeURIComponent,
    setInterval: function () { return 0; }
  });
  return { nodes: nodes, windowHandlers: windowHandlers, get: document.getElementById };
}

test('the desk asks the configured deployment for an assistant reply', async () => {
  const calls = [];
  const harness = run('website/os/ai.js', { API_URL: API }, async (url) => {
    calls.push(String(url));
    return { status: 200, ok: true, json: async () => ({ reply: 'answer' }) };
  });
  harness.get('ai-input').value = 'What is the desk?';
  await harness.nodes['ai-form'].handlers.submit[0]({ preventDefault() {} });
  assert.deepEqual(calls, [API + '/api/ai']);
  assert.equal(harness.nodes['ai-reply'].textContent, 'answer');
});

test('the desk asks the configured deployment for the feed', async () => {
  const calls = [];
  const harness = run('website/os/feed.js', { API_URL: API }, async (url) => {
    calls.push(String(url));
    return { status: 200, ok: true, json: async () => ({ solPriceUsd: 145.2 }) };
  });
  await harness.windowHandlers['valhalla-signed-in'][0]();
  assert.deepEqual(calls, [API + '/api/feed']);
  assert.equal(harness.nodes['feed-status'].textContent, 'Live feed');
});

test('the health page asks the configured deployment for its status', async () => {
  const calls = [];
  const harness = run('website/health/health.js', { API_URL: API }, async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      ok: true,
      json: async () => ({
        status: 'up',
        mode: 'live',
        checkedAt: '2026-11-12T21:00:00.000Z',
        checks: [{ name: 'supabase', status: 'up', latencyMs: 12 }],
        safety: { trading: 'disabled', social: 'disabled', keyStorage: 'disabled', adminConfigured: true }
      })
    };
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepEqual(calls, [API + '/api/health']);
  assert.equal(harness.nodes['overall'].textContent, 'Up');
  assert.equal(harness.nodes['systems'].children.length, 1);
});

test('an empty API_URL keeps the health check on the same origin', async () => {
  const calls = [];
  run('website/health/health.js', {}, async (url) => {
    calls.push(String(url));
    return { status: 200, ok: true, json: async () => ({ checks: [], safety: {} }) };
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepEqual(calls, ['/api/health']);
});

test('an empty API_URL keeps both calls on the same origin', async () => {
  const calls = [];
  const harness = run('website/os/ai.js', {}, async (url) => {
    calls.push(String(url));
    return { status: 200, ok: true, json: async () => ({ reply: 'answer' }) };
  });
  harness.get('ai-input').value = 'Hello';
  await harness.nodes['ai-form'].handlers.submit[0]({ preventDefault() {} });
  assert.deepEqual(calls, ['/api/ai']);
});
