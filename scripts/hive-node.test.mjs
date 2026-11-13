import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { applyRelease, HiveNodeUpdater, saveNodeState, safeReleasePath } from './hive-node.mjs';
import { signRelease } from './hive-updater.mjs';
import { startWrenRelay } from './wren-relay.mjs';

const keys = generateKeyPairSync('ed25519');

function customer(overrides = {}) {
  return {
    id: 'node-a',
    role: 'customer',
    channel: 'akershus',
    version: '1.0.0',
    issuedAt: 0,
    knownGood: [],
    ...overrides
  };
}

function release(overrides = {}) {
  return signRelease({
    channel: 'akershus',
    path: 'akershus/system',
    version: '1.0.1',
    category: 'system',
    files: [{ name: 'app.txt', text: 'version two' }],
    issuedAt: 1,
    ...overrides
  }, keys.privateKey);
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('installs an ordinary release, runs health, launches, and returns the new state', async t => {
  const root = await tempRoot(t);
  let healthVersion = '';
  let launchedVersion = '';

  const result = await applyRelease({
    release: release({ files: [{ name: 'config/app.txt', text: 'version two' }] }),
    publicKey: keys.publicKey,
    node: customer(),
    root,
    now: 10_000,
    healthCheck: async node => { healthVersion = node.version; },
    launch: async node => { launchedVersion = node.version; }
  });

  assert.equal(result.applied, true);
  assert.equal(result.installed, true);
  assert.equal(result.node.version, '1.0.1');
  assert.equal(healthVersion, '1.0.1');
  assert.equal(launchedVersion, '1.0.1');
  assert.equal(await readFile(path.join(root, 'config/app.txt'), 'utf8'), 'version two');
  assert.equal(result.node.knownGood.at(-1).version, '1.0.1');
});

test('restores the previous file and leaves the node version unchanged when health fails', async t => {
  const root = await tempRoot(t);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'app.txt'), 'version one', 'utf8');

  const result = await applyRelease({
    release: release(),
    publicKey: keys.publicKey,
    node: customer(),
    root,
    now: 10_000,
    healthCheck: async () => { throw new Error('health endpoint returned 503'); },
    launch: async () => {}
  });

  assert.equal(result.applied, false);
  assert.equal(result.installed, false);
  assert.match(result.reason, /health endpoint returned 503/);
  assert.equal(result.node.version, '1.0.0');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'version one');
});

test('refuses a release file that escapes the install root', async t => {
  const root = await tempRoot(t);
  const outside = path.join(path.dirname(root), 'escaped.txt');
  await rm(outside, { force: true });

  const result = await applyRelease({
    release: release({ files: [{ name: '../escaped.txt', text: 'do not write' }] }),
    publicKey: keys.publicKey,
    node: customer(),
    root,
    now: 10_000
  });

  assert.equal(result.applied, false);
  assert.equal(result.installed, false);
  assert.match(result.reason, /Unsafe release path/);
  await assert.rejects(readFile(outside, 'utf8'), { code: 'ENOENT' });
});

test('safe paths reject absolute, parent, and drive-qualified names', () => {
  assert.equal(safeReleasePath('config/app.txt'), 'config/app.txt');
  for (const value of ['/etc/passwd', '../app.txt', 'config/../../app.txt', 'C:\\app.txt', 'C:app.txt', '.hive/node.json', '']) {
    assert.throws(() => safeReleasePath(value), /Unsafe release path|invalid/);
  }
});

test('node state is written atomically and can be read back', async t => {
  const root = await tempRoot(t);
  const file = path.join(root, '.hive', 'node.json');
  const node = customer({ version: '1.0.1', issuedAt: 9 });
  await saveNodeState(file, node);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), node);
});

async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

test('a relay release reaches a running node and installs before it reports healthy', async t => {
  const root = await tempRoot(t);
  const relay = await startWrenRelay({
    publicKey: keys.publicKey,
    token: 'node-token',
    host: '127.0.0.1',
    port: 0
  });
  t.after(() => relay.close());

  let healthPassed = false;
  let launched = false;
  const updater = new HiveNodeUpdater({
    relayUrl: relay.url,
    token: 'node-token',
    publicKey: keys.publicKey,
    root,
    node: customer(),
    pollMs: 100,
    healthCheck: async () => { healthPassed = true; },
    launch: async () => { launched = true; }
  });
  await updater.start();
  t.after(() => updater.stop());

  await new Promise(resolve => setTimeout(resolve, 50));
  const response = await fetch(`${relay.url}/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer node-token'
    },
    body: JSON.stringify(release())
  });
  assert.equal(response.status, 200);

  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(path.join(root, '.hive/node.json'), 'utf8')).version === '1.0.1';
    } catch {
      return false;
    }
  });
  assert.equal(healthPassed, true);
  assert.equal(launched, true);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'version two');

  await new Promise(resolve => setTimeout(resolve, 100));
  const health = await (await fetch(`${relay.url}/health`)).json();
  assert.equal(health.nodes.find(node => node.nodeId === 'node-a').healthy, true);
});
