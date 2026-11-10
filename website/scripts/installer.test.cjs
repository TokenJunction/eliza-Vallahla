const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');

function tar(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(data.length.toString(8).padStart(11, '0'), 124);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar', 257);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0'), 148);
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, data);
    if (data.length % 512) chunks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function load() {
  const context = { window: {}, TextDecoder, Blob, Response, DecompressionStream };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'website/os/installer.js'), 'utf8'), context);
  return context.window.ValhallaInstaller;
}

test('sample zip installs and a Flatpak without a manifest is refused', async () => {
  const installer = load();
  const hello = fs.readFileSync(path.join(root, 'website/os/samples/hello-valos.zip'));
  const installed = await installer.installPack(hello, 'hello-valos.zip');
  assert.equal(installed.ok, true);
  assert.equal(installed.app.name, 'Hello ValOS');
  assert.match(installed.app.html, /does not trade/);

  const rejected = fs.readFileSync(path.join(root, 'website/os/samples/rejected-pack.zip'));
  const refused = await installer.installPack(rejected, 'rejected-pack.zip');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /not converted into a Bun app/);
});

test('a tar with a ValOS entry installs only that entry, and secrets fail closed', async () => {
  const installer = load();
  const wrapped = await installer.installPack(tar({
    metadata: '[Application]\nname=NotValOS\n',
    'valos-app.json': JSON.stringify({ name: 'Wrapped', version: '1', entry: 'index.html', permissions: ['window'] }),
    'index.html': '<p>Wrapped entry. It does not trade.</p>'
  }), 'wrapped.tar');
  assert.equal(wrapped.ok, true);
  assert.match(wrapped.note, /not converted into a Bun app/i);

  const secret = await installer.installPack(tar({
    'valos-app.json': JSON.stringify({ name: 'Secret', version: '1', entry: 'index.html', permissions: ['window'] }),
    'index.html': '<p>no</p>',
    '.env': 'TOKEN=nope'
  }), 'secret.tar');
  assert.equal(secret.ok, false);
  assert.match(secret.reason, /secret file/i);
  assert.equal(secret.app, undefined);
});

test('pretest patch decision reloads once and then fails closed', () => {
  const context = { window: {}, document: { getElementById() { return null; } } };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'website/os/pretest.js'), 'utf8'), context);
  const pretest = context.window.ValhallaPretest;
  assert.equal(pretest.decidePatch('1.4.2', '1.4.2', false).action, 'stay');
  assert.equal(pretest.decidePatch('1.4.2', '1.4.3', false).action, 'reload');
  assert.equal(pretest.decidePatch('1.4.2', '1.4.3', true).action, 'fail');
  assert.match(pretest.decidePatch('1.4.2', '1.4.3', true).reason, /did not replace/);
});

test('a saved app is shown again when the installer loads', () => {
  const items = [];
  const frame = { hidden: true, srcdoc: '' };
  const document = {
    getElementById(id) {
      if (id === 'install-list') return { replaceChildren() { items.length = 0; }, appendChild(child) { items.push(child); } };
      if (id === 'install-preview') return frame;
      if (id === 'install-file') return { addEventListener() {} };
      return null;
    },
    createElement() { return { textContent: '' }; },
    querySelectorAll() { return []; }
  };
  const store = { getItem() { return JSON.stringify([{ name: 'Hello ValOS', version: '0.1.0', entry: 'index.html', html: '<p>kept</p>', bunOnly: false }]); } };
  const context = { window: {}, document, localStorage: store, TextDecoder, Blob, Response };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'website/os/installer.js'), 'utf8'), context);
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /Hello ValOS/);
  assert.equal(frame.hidden, false);
  assert.equal(frame.srcdoc, '<p>kept</p>');
});
