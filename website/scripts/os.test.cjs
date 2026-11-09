const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('web shell navigates only to its two local pages', () => {
  const nodes = {};
  function node(id) {
    return nodes[id] ||= {
      hidden: true, dataset: {}, style: {}, textContent: '', handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute() {}, replaceChildren() {}, querySelector() { return null; }
    };
  }
  const iframe = { src: '/' }, link = { href: '/' };
  const document = {
    getElementById: node,
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === '#window-browser iframe') return iframe;
      if (selector === '#window-browser .address-row a') return link;
      return node(selector);
    },
    addEventListener() {}
  };
  const window = { setTimeout() {}, clearTimeout() {}, setInterval() {}, addEventListener() {} };
  const source = fs.readFileSync(path.join(__dirname, '../../site-build/os/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Date, AbortController,
    fetch: () => new Promise(() => {})
  });
  const change = node('browser-page').handlers.change;
  change({ target: { value: '/status/' } });
  assert.equal(iframe.src, '/status/');
  assert.equal(link.href, '/status/');
  change({ target: { value: 'javascript:alert(1)' } });
  assert.equal(iframe.src, '/status/');
  assert.equal(link.href, '/status/');
  change({ target: { value: '/' } });
  assert.equal(iframe.src, '/');
  assert.equal(link.href, '/');
});

test('system status stays unknown without a configured status service', () => {
  const nodes = {}, requests = [];
  function node(id) {
    return nodes[id] ||= {
      hidden: true, dataset: {}, style: {}, textContent: '', handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute() {}, replaceChildren() {}, querySelector() { return null; }
    };
  }
  const document = {
    getElementById: node,
    querySelectorAll: () => [],
    querySelector: node,
    addEventListener() {}
  };
  const window = {
    VALHALLA_SITE: { STATUS_URL: '' },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, addEventListener() {}
  };
  const source = fs.readFileSync(path.join(__dirname, '../../site-build/os/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Date, URL,
    AbortController,
    fetch(url) { requests.push(url); throw new Error('unexpected request'); }
  });
  assert.deepEqual(requests, []);
  assert.match(node('backend-status').textContent, /status feed is not configured; service health is unknown/);
});

test('system status reads only the configured HTTPS feed and rejects stale data', async () => {
  const nodes = {}, requests = [];
  function node(id) {
    return nodes[id] ||= {
      hidden: true, dataset: {}, style: {}, textContent: '', handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute() {}, replaceChildren() {}, querySelector() { return null; }
    };
  }
  const document = {
    getElementById: node,
    querySelectorAll: () => [],
    querySelector: node,
    addEventListener() {}
  };
  const window = {
    VALHALLA_SITE: { STATUS_URL: 'https://status.example.test/api' },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, addEventListener() {}
  };
  const lines = ['VALHALLA CORE', 'MECHA BRAIN', 'ASK VALHALLA', 'ODIN FEED', 'FORGE LAB', 'HEIMDALL GATE', 'SENTINEL WATCH']
    .map(name => ({ name, state: 'LIVE' }));
  const source = fs.readFileSync(path.join(__dirname, '../../site-build/os/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Date, URL, AbortController,
    fetch(url, options) {
      requests.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ checkedAt: Date.now() - 16 * 60 * 1000, lines }) });
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://status.example.test/api');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.match(node('backend-status').textContent, /Unavailable/);
  assert.doesNotMatch(node('backend-status').textContent, /Systems · LIVE/);
});
