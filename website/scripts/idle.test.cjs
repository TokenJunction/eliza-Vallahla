const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('background windows sleep and a hidden tab freezes polling', async () => {
  const nodes = {};
  function element(id) {
    return nodes[id] ||= {
      id, hidden: true, dataset: {}, style: {}, textContent: '', handlers: {},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] || ''; },
      querySelector() { return null; },
      replaceChildren() {},
      appendChild() {},
      focus() {}
    };
  }
  const windows = ['status', 'wallet', 'memory'].map(name => {
    const view = element('window-' + name);
    view.dataset.window = name;
    view.querySelector = selector => selector === '.title-bar h2' ? { textContent: name } : null;
    return view;
  });
  let hidden = false;
  const events = {};
  const document = {
    getElementById: element,
    documentElement: element('root'),
    createElement() { return element('created'); },
    querySelector(selector) { return selector === '.status-light' ? element('status-light') : null; },
    querySelectorAll(selector) { return selector === '[data-window]' ? windows : []; },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    get hidden() { return hidden; }
  };
  const desktop = element('desktop');
  const context = {
    document,
    window: {
      setTimeout() { return 1; },
      clearTimeout() {},
      setInterval() { return 7; },
      clearInterval() {},
      addEventListener() {},
      innerWidth: 1280,
      innerHeight: 800
    },
    Date,
    AbortController,
    fetch: async () => ({ ok: false, headers: { get: () => 'text/html' }, text: async () => '', json: async () => ({}) })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../os/app.js'), 'utf8'), context);
  function open(name) {
    const button = { dataset: { open: name }, closest(selector) { return selector === '[data-open]' ? button : null; } };
    for (const fn of desktop.handlers.click) fn({ target: button, button: 0, preventDefault() {} });
  }
  open('status');
  open('wallet');
  open('memory');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('window-status').dataset.idle, 'sleeping');
  assert.equal(element('window-memory').dataset.idle, 'active');
  assert.equal(desktop.dataset.polling, 'off');
  hidden = true;
  for (const fn of events.visibilitychange) fn();
  assert.equal(document.documentElement.dataset.doze, 'yes');
  assert.equal(element('window-memory').dataset.idle, 'sleeping');
  assert.equal(desktop.dataset.clock, 'off');
  assert.equal(desktop.dataset.polling, 'off');
  hidden = false;
  for (const fn of events.visibilitychange) fn();
  assert.equal(document.documentElement.dataset.doze, 'no');
  assert.equal(element('window-memory').dataset.idle, 'active');
});
