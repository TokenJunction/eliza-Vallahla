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
  const memory = element('window-memory');
  const close = { dataset: { action: 'close' }, closest(selector) {
    if (selector === '[data-action]') return close;
    if (selector === '[data-window]') return memory;
    return null;
  } };
  for (const fn of desktop.handlers.click) fn({ target: close, button: 0, preventDefault() {} });
  assert.equal(memory.hidden, true);
  assert.equal(element('window-status').dataset.idle, 'active');
  hidden = true;
  for (const fn of events.visibilitychange) fn();
  assert.equal(document.documentElement.dataset.doze, 'yes');
  assert.equal(element('window-memory').dataset.idle, 'sleeping');
  assert.equal(desktop.dataset.clock, 'off');
  assert.equal(desktop.dataset.polling, 'off');
  hidden = false;
  for (const fn of events.visibilitychange) fn();
  assert.equal(document.documentElement.dataset.doze, 'no');
  assert.equal(element('window-memory').dataset.idle, 'sleeping');
  assert.equal(element('window-status').dataset.idle, 'active');
});

test('a srcdoc preview comes back when its window wakes', () => {
  const frame = { src: '', srcdoc: '<p>kept</p>', dataset: {}, setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] || ''; } };
  const view = {
    hidden: false, dataset: { window: 'installer' }, style: {}, textContent: '',
    querySelector(selector) { return selector === 'iframe' ? frame : (selector === '.title-bar h2' ? { textContent: 'Installer' } : null); },
    addEventListener() {}, setAttribute() {}, replaceChildren() {}, appendChild() {}, focus() {}
  };
  const document = {
    getElementById(id) {
      if (id === 'window-installer') return view;
      if (id === 'desktop') return { dataset: {}, addEventListener() {} };
      if (id === 'taskbar-apps') return { replaceChildren() {}, appendChild() {}, querySelector() { return null; } };
      if (id === 'start-menu') return { hidden: true, contains() { return false; } };
      if (id === 'start-button') return { setAttribute() {}, contains() { return false; }, addEventListener() {} };
      if (id === 'browser-page') return { addEventListener() {} };
      return { textContent: '', dataset: {}, addEventListener() {}, hidden: true, style: {} };
    },
    documentElement: { dataset: {} },
    createElement() { return { textContent: '', dataset: {}, setAttribute() {}, addEventListener() {} }; },
    querySelector() { return { style: {} }; },
    querySelectorAll(selector) { return selector === '[data-window]' ? [view] : []; },
    addEventListener() {},
    hidden: false
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../os/app.js'), 'utf8'), {
    document,
    window: { setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, addEventListener() {}, innerWidth: 800, innerHeight: 600, location: { search: '' } },
    Date, AbortController, URLSearchParams,
    fetch: async () => ({ ok: false, headers: { get: () => '' }, text: async () => '' })
  });
  assert.equal(frame.dataset.resumeDoc, '<p>kept</p>');
  assert.equal(frame.srcdoc, '<p>kept</p>');
  assert.equal(view.dataset.idle, 'active');
});
