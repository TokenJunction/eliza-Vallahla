'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Element {
  constructor() {
    this.dataset = {};
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  appendChild(child) { this.children.push(child); }
  querySelector() { return this.button; }
  focus() {}
}

function setup(options = {}) {
  const ids = ['wallet-status', 'overview-wallet', 'overview-wallet-detail', 'wallet-disconnect', 'chat-form', 'chat-input', 'chat-log', 'chat-status', 'chat-voice'];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements['chat-form'].button = new Element();
  const wallets = ['solflare', 'metamask'].map((name) => {
    const button = new Element();
    button.dataset.wallet = name;
    return button;
  });
  const document = {
    getElementById: (id) => elements[id],
    querySelectorAll: () => wallets,
    createElement: () => new Element(),
    createTextNode: (text) => ({ textContent: text }),
  };
  const window = {
    VALHALLA_SITE: { CHAT_URL: 'https://chat.example' },
    setTimeout,
    clearTimeout,
    ...options.window,
  };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ reply: 'Paper mode only.' }) };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8'), {
    document, window, fetch, AbortController,
  });
  return { elements, wallets, requests };
}

test('connects each wallet and clears the local connection', async () => {
  const calls = [];
  const provider = {
    isMetaMask: true,
    request: async ({ method }) => { calls.push(method); return ['0x123']; },
    on() {},
    removeListener() {},
  };
  const solflare = {
    connect: async () => ({ publicKey: 'solana-address' }),
    on() {},
    removeListener() {},
  };
  const { elements, wallets } = setup({ window: { ethereum: provider, solflare } });
  await wallets[0].listeners.click();
  await new Promise(setImmediate);
  assert.match(elements['wallet-status'].textContent, /Solflare connected: solana-address/);
  await wallets[1].listeners.click();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['eth_requestAccounts']);
  assert.match(elements['wallet-status'].textContent, /MetaMask connected: 0x123/);
  await elements['wallet-disconnect'].listeners.click();
  assert.equal(elements['overview-wallet'].textContent, 'Not connected');
  assert.match(elements['wallet-status'].textContent, /disconnect this site in MetaMask/);
});

test('reports an unavailable wallet rather than pretending to connect', () => {
  const { elements, wallets } = setup();
  wallets[0].listeners.click();
  assert.match(elements['wallet-status'].textContent, /Solflare was not detected/);
});

test('sends bounded chat through the configured service and blocks seed-like input', async () => {
  const { elements, requests } = setup();
  const submit = elements['chat-form'].listeners.submit;
  elements['chat-input'].value = 'apple '.repeat(12);
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(elements['chat-status'].textContent, /not sent/);
  elements['chat-input'].value = 'Explain paper trading';
  await submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chat.example/chat');
  assert.deepEqual(JSON.parse(requests[0].init.body), { text: 'Explain paper trading', history: [], stream: false });
  assert.equal(elements['chat-log'].children[1].children[2].textContent, 'Paper mode only.');
});

test('voice replies are opt-in and stop when disabled', async () => {
  const spoken = [];
  let cancelled = 0;
  const { elements } = setup({ window: {
    speechSynthesis: { speak: (utterance) => spoken.push(utterance.text), cancel: () => { cancelled += 1; } },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
  } });
  const submit = elements['chat-form'].listeners.submit;
  elements['chat-input'].value = 'First question';
  await submit({ preventDefault() {} });
  assert.equal(spoken.length, 0);
  elements['chat-voice'].listeners.click();
  elements['chat-input'].value = 'Second question';
  await submit({ preventDefault() {} });
  assert.deepEqual(spoken, ['Paper mode only.']);
  elements['chat-voice'].listeners.click();
  assert.equal(elements['chat-voice']['aria-pressed'], 'false');
  assert.equal(cancelled, 2);
});
