const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../connect/connect-page.js'), 'utf8');

test('wallet connect does not request a signature or hand off without a verified service', () => {
  const nodes = {};
  const signatures = [];
  const messages = [];
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, hidden: true, disabled: false, textContent: '', handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }
      };
    }
    return nodes[id];
  }
  const window = {
    VALHALLA_SITE: { BRAIN_URL: '' },
    opener: { postMessage(message) { messages.push(message); } },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout() { return 1; },
    setInterval() { return 1; }
  };
  const document = { getElementById: node, querySelectorAll: () => [] };
  vm.runInNewContext(source, {
    window, document, location: { search: '', host: 'valhalla-app.xyz' },
    URLSearchParams, ValhallaConnect: {
      pickNamed: () => null,
      adapterFromInjected: async () => ({}),
      signInWithAdapter: async () => { signatures.push(true); return {}; }
    },
    Event: function (type) { this.type = type; },
    fetch: async () => { throw new Error('an unsupported endpoint must not be called'); }
  });
  node('go').handlers.click();
  assert.equal(node('go').disabled, true);
  assert.equal(node('status').textContent, 'Wallet sign-in verification is not configured. No wallet signature was requested.');
  assert.equal(signatures.length, 0);
  assert.equal(messages.length, 0);
});
