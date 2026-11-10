const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('citadel entrance, workstation zones, and volOS stay honest', () => {
  const home = read('website/index.html');
  const desk = read('website/os/index.html');
  const volos = read('website/volos/index.html');
  const config = read('website/site-config.js');
  assert.match(home, /Continue to sign-in/);
  assert.match(home, /href="\/app\/"/);
  assert.match(home, /href="\/os\/"/);
  assert.match(home, /Live trading is off/);
  assert.doesNotMatch(home, /live trading is on/i);
  const gate = read('website/app/index.html');
  assert.match(gate, /HUMAN CHECK/);
  assert.doesNotMatch(gate, /enterWorkstationSession/);
  for (const name of ['status', 'wallet', 'memory', 'browser', 'swarm']) {
    assert.match(desk, new RegExp('data-open="' + name + '"'));
    assert.match(desk, new RegExp('id="window-' + name + '"'));
  }
  assert.match(desk, /id="start-button"/);
  assert.match(desk, /Tools/);
  assert.match(desk, /href="\/app\/">Account/);
  assert.doesNotMatch(desk, /data-enter-desk/);
  for (const label of ['Market', 'Hardware', 'Wallet', 'Assistant']) {
    assert.match(desk, new RegExp(label));
  }
  assert.match(desk, /NOT CONNECTED/);
  assert.match(desk, /No prices, volume, or token lists are loaded/);
  assert.match(desk, /No CPU, GPU, or network reading/);
  assert.match(desk, /LIVE TRADING OFF/);
  assert.doesNotMatch(desk + volos + home, /14\.85|2,884\.61|\$2,884\.61/);
  assert.match(volos, /Not published/);
  assert.match(volos, /Swap unavailable/);
  assert.match(config, /LIVE_TRADING:\s*false/);
  assert.doesNotMatch(read('website/os/bridge.js'), /eth_sendTransaction|signTransaction|signMessage|personal_sign/);
});

test('overseer playbook fails closed and the critic only proposes a patch', async () => {
  const quality = await import(path.join(root, 'self-healing/quality-matrix.mjs'));
  const context = { window: { ValhallaQuality: quality }, Date };
  context.window.window = context.window;
  vm.runInNewContext(read('website/os/overseer.js'), context);
  const overseer = context.window.ValhallaOverseer;
  assert.equal(overseer.maskAddress('So11111111111111111111111111111111111111112'), '…1112');
  assert.equal(overseer.maskAddress('WalletEndingC8sm').endsWith('C8sm'), true);

  const opened = overseer.prepare('Open system status');
  assert.equal(opened.open, 'status');
  assert.match(opened.answer, /not connected/i);
  const market = overseer.prepare('What is the hardware reading?');
  assert.match(market.answer, /not connected/i);
  assert.doesNotMatch(market.answer, /%|GHz|SOL/);

  const volos = overseer.prepare('What is the volOS contract address?');
  assert.equal(volos.handled, true);
  assert.match(volos.answer, /unpublished/i);
  assert.doesNotMatch(volos.answer, /[1-9A-HJ-NP-Za-km-z]{32,44}/);

  const trade = overseer.prepare('Swap 2 SOL now');
  assert.match(trade.answer, /Live trading is off/);
  assert.match(trade.answer, /will not request a transaction or signature/);

  const wallet = overseer.prepare('Which wallet and balance should you acknowledge?');
  assert.match(wallet.answer, /…C8sm/);
  assert.match(wallet.answer, /\$5\.58/);
  assert.doesNotMatch(wallet.answer, /14\.85|2,884/);

  const passed = overseer.review({
    goal: 'What is the volOS contract?',
    answer: volos.answer,
    evidence: [],
    latencyMs: 40,
    saidStillWorking: true,
    claimedLive: false,
    inventedContract: false
  });
  assert.equal(passed.reward, 1);
  assert.equal(passed.patch, null);

  const screened = overseer.screenReply('Buy the mint So11111111111111111111111111111111111111112 now. It will pump.');
  assert.equal(screened.ok, false);
  const failed = overseer.review({
    goal: 'Trade volOS',
    answer: screened.text,
    evidence: ['screened model reply'],
    latencyMs: 30,
    saidStillWorking: true,
    inventedContract: true,
    claimedLive: true,
    liveVerified: false
  });
  assert.equal(failed.reward, -1);
  assert.match(failed.patch, /invented|unverified|not verified/i);
  assert.doesNotMatch(JSON.stringify(failed), /apply.*dns|rotate secrets/i);
});

test('asking the copilot to open status opens that window and does not trade', async () => {
  const quality = await import(path.join(root, 'self-healing/quality-matrix.mjs'));
  const nodes = {};
  function element(id) {
    return nodes[id] ||= {
      id, hidden: id.startsWith('window-'), dataset: {}, style: {}, textContent: '', value: '', disabled: false,
      className: '', children: [], handlers: {},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      setAttribute() {},
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); return child; },
      contains() { return false; },
      focus() {},
      querySelector() { return element(id + '-child'); },
      click() { (this.handlers.click || []).forEach(fn => fn({ target: this, preventDefault() {}, button: 0 })); }
    };
  }
  const windows = ['status', 'swarm', 'memory', 'browser', 'wallet'].map(name => {
    const view = element('window-' + name);
    view.dataset.window = name;
    view.querySelector = selector => selector === '.title-bar h2' ? { textContent: name } : null;
    return view;
  });
  const statusButton = element('open-status');
  statusButton.dataset.open = 'status';
  statusButton.click = function () {
    (desktop.handlers.click || []).forEach(fn => fn({
      target: { closest(selector) { return selector === '[data-open]' ? statusButton : null; } },
      preventDefault() {},
      button: 0
    }));
  };
  const desktop = element('desktop');
  desktop.querySelector = selector => selector === '.dock [data-open="status"]' ? statusButton : null;
  const form = element('chat-form');
  const input = element('chat-input');
  const log = element('chat-log');
  const document = {
    getElementById(id) {
      if (id === 'desktop') return desktop;
      if (id === 'chat-form') return form;
      if (id === 'chat-input') return input;
      if (id === 'chat-log') return log;
      return element(id);
    },
    createElement() { return element('created-' + Math.random()); },
    createTextNode(text) { return { text }; },
    querySelector(selector) {
      if (selector === '.status-light') return element('status-light');
      if (selector === '#window-browser iframe') return element('iframe');
      if (selector === '#window-browser .address-row a') return element('browser-link');
      return desktop.querySelector(selector);
    },
    querySelectorAll(selector) { return selector === '[data-window]' ? windows : []; },
    addEventListener() {}
  };
  const fetches = [];
  const context = {
    document,
    window: {
      ValhallaQuality: quality,
      VALHALLA_SITE: { CHAT_URL: '' },
      setTimeout() { return 1; },
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {},
      addEventListener() {},
      innerWidth: 1280,
      innerHeight: 800
    },
    Date, AbortController,
    fetch: async (url) => { fetches.push(url); return { ok: false, headers: { get: () => 'text/html' }, json: async () => ({}) }; }
  };
  context.window.window = context.window;
  context.window.document = document;
  vm.runInNewContext(
    read('website/os/quality-matrix.js') + '\n' + read('website/os/overseer.js') + '\n' + read('website/os/app.js') + '\n' + read('website/os/bridge.js'),
    context
  );
  input.value = 'Open system status';
  await form.handlers.submit[0]({ preventDefault() {} });
  assert.equal(element('window-status').hidden, false);
  assert.equal(fetches.filter(url => String(url).includes('/chat')).length, 0);
  assert.match(log.children.map(node => JSON.stringify(node)).join(' '), /not connected/i);
  assert.doesNotMatch(element('chat-status').textContent, /transaction was sent|signature requested/i);
  await new Promise(resolve => setImmediate(resolve));
});
