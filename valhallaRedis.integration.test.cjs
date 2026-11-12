'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Queue, Worker, QueueEvents } = require('bullmq');
const { createValhallaQueueEngine } = require('./valhallaQueueEngine');

const binary = process.env.VALHALLA_TEST_REDIS_SERVER;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error('fixture_wait_timeout');
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRedis(dir, port, tls = false) {
  const args = ['--bind', '127.0.0.1', '::1', '--protected-mode', 'yes', '--save', '', '--appendonly', 'no', '--dir', dir];
  if (tls) {
    args.push('--port', '0', '--tls-port', String(port), '--tls-cert-file', path.join(dir, 'cert.pem'),
      '--tls-key-file', path.join(dir, 'key.pem'), '--tls-ca-cert-file', path.join(dir, 'cert.pem'), '--tls-auth-clients', 'no');
  } else {
    args.push('--port', String(port));
  }
  const child = spawn(binary, args, { env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' } });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    await until(() => {
      if (child.exitCode !== null) throw new Error('redis_fixture_start_failed');
      return output.includes('Ready to accept connections');
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return child;
}

test('real client startup deadline and cancellation against a stalled loopback socket', { timeout: 5000 }, async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `redis://127.0.0.1:${server.address().port}`;
    try {
      await assert.rejects(createValhallaQueueEngine({ redisUrl: url, role: 'consumer', startupTimeoutMs: 100 }), /startup_timeout/);
      const controller = new AbortController();
      const pending = createValhallaQueueEngine({ redisUrl: url, role: 'consumer', signal: controller.signal });
      await until(() => sockets.size > 0);
      controller.abort();
      await assert.rejects(pending, /startup_cancelled/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
    await assert.rejects(
      createValhallaQueueEngine({ redisUrl: url, role: 'consumer', startupTimeoutMs: 200 }),
      /startup_timeout|redis_unavailable/,
    );
  });

  test('production TLS verifies certificate trust and hostname on isolated Redis', { skip: !binary, timeout: 30000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-tls-'));
    const port = await unusedPort();
    let redis;
    try {
      const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      ], { encoding: 'utf8' });
      assert.equal(generated.status, 0, 'fixture certificate generation failed');
      redis = await startRedis(dir, port, true);
      const ca = path.join(dir, 'cert.pem');
      const url = `rediss://127.0.0.1:${port}`;
      const child = workerProcess(url, { production: true, ca });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      try {
        await until(() => {
          if (child.exitCode !== null) throw new Error('tls_worker_start_failed');
          return output.includes('"ready":true');
        });
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        assert.equal((await exited)[0], 0);
        assert.match(output, /"ready":false/);
      } finally {
        await stopChild(child);
      }

      const probe = `
        const Redis = require('ioredis');
        const client = new Redis(process.argv[1], { retryStrategy: () => null, connectTimeout: 2000 });
        client.on('error', error => console.log(error.code));
        client.ping().then(() => { console.log('connected'); client.disconnect(); },
          error => { console.log(error.code); client.disconnect(); process.exitCode = 1; });
      `;
      for (const [target, trusted, expected] of [
        [url, false, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
        [`rediss://localhost:${port}`, true, 'ERR_TLS_CERT_ALTNAME_INVALID'],
      ]) {
        const result = spawnSync(process.execPath, ['-e', probe, target], {
          cwd: __dirname,
          env: { PATH: process.env.PATH, ...(trusted ? { NODE_EXTRA_CA_CERTS: ca } : {}) },
          encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stdout, new RegExp(expected));
      }
      t.diagnostic('trusted TLS worker ready; untrusted and wrong-host certificates rejected');
    } finally {
      await stopChild(redis);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function workerProcess(url, extra = {}) {
  return spawn(process.execPath, ['valhallaWorker.js'], {
    cwd: __dirname,
    env: {
      PATH: process.env.PATH, NODE_ENV: extra.production ? 'production' : 'test',
      VALHALLA_QUEUE_ENABLED: 'true', VALHALLA_QUEUE_ROLE: 'consumer',
      VALHALLA_EXECUTION_MODE: 'paper', REDIS_URL: url,
      ...(extra.ca ? { NODE_EXTRA_CA_CERTS: extra.ca } : {}),
    },
  });
}

test('isolated real Redis integration, lifecycle and bounded load', { skip: !binary, timeout: 60000 }, async (t) => {
  assert.ok(path.isAbsolute(binary));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-test-'));
  const port = await unusedPort();
  const url = `redis://127.0.0.1:${port}`;
  let redis;
  let producer;
  let consumer;
  const events = [];
  let active = 0;
  let peak = 0;
  const activeByQueue = new Map();
  let peakPerQueue = 0;
  let queuesCreated = 0;
  let workersCreated = 0;
  class CountingQueue extends Queue {
    constructor(...args) { super(...args); queuesCreated++; }
  }
  class MeasuringWorker extends Worker {
    constructor(name, processor, opts) {
      super(name, async (...args) => {
        active++;
        peak = Math.max(peak, active);
        const count = (activeByQueue.get(name) || 0) + 1;
        activeByQueue.set(name, count);
        peakPerQueue = Math.max(peakPerQueue, count);
        try {
          await sleep(2);
          return await processor(...args);
        } finally {
          active--;
          activeByQueue.set(name, activeByQueue.get(name) - 1);
        }
      }, opts);
      workersCreated++;
    }
  }
  try {
    redis = await startRedis(dir, port);
    producer = await createValhallaQueueEngine({ redisUrl: url, role: 'producer', QueueClass: CountingQueue, WorkerClass: MeasuringWorker });
    assert.equal(queuesCreated, 3);
    assert.equal(workersCreated, 0);
    consumer = await createValhallaQueueEngine({ redisUrl: url, role: 'consumer', QueueClass: CountingQueue, WorkerClass: MeasuringWorker });
    assert.equal(queuesCreated, 3);
    assert.equal(workersCreated, 3);
    assert.equal(producer.getStatus().ready, true);
    assert.equal(consumer.getStatus().ready, true);
    for (const name of ['zeus', 'gorgo', 'cerberus']) {
      const event = new QueueEvents(`valhalla-${name}`, { connection: { host: '127.0.0.1', port } });
      event.on('error', () => {});
      await event.waitUntilReady();
      events.push(event);
    }
    const queues = ['zeus', 'gorgo', 'cerberus'].map((name) =>
      new Queue(`valhalla-${name}`, { connection: { host: '127.0.0.1', port } }));
    try {
      const jobs = [
        ['zeus', 'health-check', {}, 'observed'],
        ['zeus', 'policy-check', { mode: 'paper' }, 'paper_only'],
        ['gorgo', 'sandbox-health', {}, 'ready_for_simulation'],
        ['gorgo', 'paper-simulation', { scenario: 'baseline' }, 'simulated'],
        ['gorgo', 'paper-simulation', { scenario: 'risk-limit' }, 'simulated'],
        ['cerberus', 'vault-check', {}, 'blocked'],
      ];
      const index = { zeus: 0, gorgo: 1, cerberus: 2 };
      for (const [targetEngine, taskName, payload, expected] of jobs) {
        const job = await producer.enqueue({ targetEngine, taskName, payload });
        const result = await job.waitUntilFinished(events[index[targetEngine]], 5000);
        assert.equal(result.status, expected);
      }
      for (const [name, data] of [
        ['trade', { payload: {} }],
        ['sandbox-health', null],
        ['sandbox-health', {}],
        ['sandbox-health', { payload: { unexpected: true } }],
        ['paper-simulation', { payload: { scenario: 'not-allowed' } }],
        ['sandbox-health', { payload: {}, tenant: 'unverified' }],
      ]) {
        const job = await queues[1].add(name, data, { attempts: 5, backoff: { type: 'fixed', delay: 25 } });
        await assert.rejects(job.waitUntilFinished(events[1], 5000), /invalid_job/);
        const actual = await queues[1].getJob(job.id);
        assert.equal(actual.attemptsMade, 1);
        assert.equal(await actual.getState(), 'failed');
      }
      const start = performance.now();
      const rss = process.memoryUsage().rss;
      const latencies = [];
      let failed = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 20; i++) {
          if (performance.now() - start >= 28000) break;
          const begin = performance.now();
          try {
            const job = await producer.enqueue({ targetEngine: 'gorgo', taskName: 'paper-simulation', payload: { scenario: 'baseline' } });
            await job.waitUntilFinished(events[1], 1000);
          } catch {
            failed++;
          }
          latencies.push(performance.now() - begin);
        }
      }));
      const elapsed = performance.now() - start;
      assert.equal(latencies.length, 80);
      assert.equal(failed, 0);
      assert.ok(elapsed < 30000);
      assert.equal(peakPerQueue, 1);
      t.diagnostic(`real loopback: completed=80 failed=${failed} clients=4 peak_processors=${peak} peak_per_queue=${peakPerQueue} elapsed_ms=${elapsed.toFixed(2)} latency_max_ms=${Math.max(...latencies).toFixed(2)} rss_delta_bytes=${process.memoryUsage().rss - rss}`);
    } finally {
      await Promise.all(queues.map((queue) => queue.close()));
      await Promise.all(events.map((event) => event.close()));
    }
    await stopChild(redis);
    await until(() => !producer.getStatus().ready && !consumer.getStatus().ready);
    redis = await startRedis(dir, port);
    await until(() => producer.getStatus().ready && consumer.getStatus().ready, 15000);
    const restoredEvents = new QueueEvents('valhalla-zeus', { connection: { host: '127.0.0.1', port } });
    restoredEvents.on('error', () => {});
    try {
      await restoredEvents.waitUntilReady();
      const restored = await producer.enqueue({ targetEngine: 'zeus', taskName: 'health-check' });
      assert.equal((await restored.waitUntilFinished(restoredEvents, 5000)).status, 'observed');
    } finally {
      await restoredEvents.close();
    }
    t.diagnostic('disconnect and reconnect readiness observed');
    await consumer.close();
    consumer = null;
    await producer.close();
    producer = null;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const child = workerProcess(url);
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      try {
        await until(() => output.includes('"ready":true'));
        const exited = once(child, 'exit');
        child.kill(signal);
        const [code, signalCode] = await exited;
        assert.equal(code, 0);
        assert.equal(signalCode, null);
        assert.match(output, /"ready":false/);
      } finally {
        await stopChild(child);
      }
    }
    t.diagnostic('SIGTERM and SIGINT closed active consumer processes');
  } finally {
    if (consumer) await consumer.close();
    if (producer) await producer.close();
    await stopChild(redis);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
