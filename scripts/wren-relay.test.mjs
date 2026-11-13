import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { signRelease } from './hive-updater.mjs';
import { startWrenRelay } from './wren-relay.mjs';

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const TOKEN = 'test-publisher-token';

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

async function relayFor(t) {
  const relay = await startWrenRelay({
    publicKey: keys.publicKey,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0
  });
  t.after(() => relay.close());
  return relay;
}

async function publish(relay, body, token = TOKEN) {
  return fetch(`${relay.url}/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function nextEvent(url) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const request = http.get(url, response => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        const match = buffer.match(/data: (.+)\n\n/);
        if (!match || finished) return;
        finished = true;
        resolve(JSON.parse(match[1]));
        request.destroy();
      });
    });
    request.on('error', error => {
      if (!finished) reject(error);
    });
    setTimeout(() => {
      if (!finished) {
        finished = true;
        request.destroy();
        reject(new Error('timed out waiting for relay event'));
      }
    }, 3000).unref();
  });
}

test('the relay rejects unauthenticated and wrongly signed releases', async t => {
  const relay = await relayFor(t);
  assert.equal((await publish(relay, release(), '')).status, 401);
  assert.equal((await publish(relay, release(), 'wrong')).status, 401);

  const forged = signRelease({
    channel: 'akershus',
    path: 'akershus/system',
    version: '1.0.1',
    category: 'system',
    files: [{ name: 'app.txt', text: 'forged' }],
    issuedAt: 1
  }, other.privateKey);
  assert.equal((await publish(relay, forged)).status, 400);
});

test('the relay publishes the latest signed release and broadcasts it to a channel', async t => {
  const relay = await relayFor(t);
  const event = nextEvent(`${relay.url}/events?channel=akershus`);
  const response = await publish(relay, release());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    channel: 'akershus',
    version: '1.0.1',
    issuedAt: 1,
    nodes: 1
  });

  const latest = await fetch(`${relay.url}/latest?channel=akershus`);
  assert.equal(latest.status, 200);
  assert.equal((await latest.json()).version, '1.0.1');
  assert.equal((await fetch(`${relay.url}/latest?channel=zeus`)).status, 204);
  assert.equal((await nextEvent(`${relay.url}/events?channel=akershus`)).version, '1.0.1');
  assert.equal((await event).version, '1.0.1');
});

test('the relay reports live health and accepts node reports', async t => {
  const relay = await relayFor(t);
  const health = await fetch(`${relay.url}/updates/health.json`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.deepEqual(healthBody.channels, ['akershus', 'zeus']);
  assert.equal(healthBody.live, true);

  const report = await fetch(`${relay.url}/report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      nodeId: 'node-a',
      channel: 'akershus',
      role: 'customer',
      version: '1.0.1',
      healthy: true,
      installed: true,
      checkedAt: 99
    })
  });
  assert.equal(report.status, 200);
  const snapshot = await (await fetch(`${relay.url}/health`)).json();
  assert.equal(snapshot.nodes[0].nodeId, 'node-a');
  assert.equal(snapshot.nodes[0].healthy, true);
});

test('a channel cannot move backward in issue time', async t => {
  const relay = await relayFor(t);
  assert.equal((await publish(relay, release({ version: '1.0.2', issuedAt: 2 }))).status, 200);
  assert.equal((await publish(relay, release({ version: '1.0.3', issuedAt: 1 }))).status, 409);
});
