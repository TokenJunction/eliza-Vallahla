'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHook } = require('node:async_hooks');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');
const { createValhallaQueueEngine } = require('./valhallaQueueEngine');

const binary = process.env.VALHALLA_TEST_REDIS_SERVER;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const childErrors = new WeakMap();

function spawnFixture(...args) {
  const child = spawn(...args);
  const record = { error: null, onError: (error) => { record.error = error; } };
  childErrors.set(child, record);
  child.on('error', record.onError);
  return child;
}

async function withCleanup(t, body, actions) {
  let result;
  let failure;
  let failed = false;
  try {
    result = await body();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const errors = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (failed) {
    for (const error of errors) t.diagnostic(`cleanup failed: ${error.message}`);
    throw failure;
  }
  if (errors.length) throw new AggregateError(errors, 'fixture_cleanup_failed');
  return result;
}

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

async function startRedis(dir, port, tls = false, t) {
  const args = ['--bind', '127.0.0.1', '::1', '--protected-mode', 'yes', '--save', '', '--appendonly', 'no', '--dir', dir];
  if (tls) {
    args.push('--port', '0', '--tls-port', String(port), '--tls-cert-file', path.join(dir, 'cert.pem'),
      '--tls-key-file', path.join(dir, 'key.pem'), '--tls-ca-cert-file', path.join(dir, 'cert.pem'), '--tls-auth-clients', 'no');
  } else {
    args.push('--port', String(port));
  }
  const child = spawnFixture(binary, args, { env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' } });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  try {
    await until(() => {
      if (childErrors.get(child).error || child.exitCode !== null || child.signalCode !== null) throw new Error('redis_fixture_start_failed');
      return output.includes('Ready to accept connections');
    });
  } catch (error) {
    try {
      await stopChild(child);
    } catch (cleanupError) {
      t.diagnostic(`cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }

  return child;
}

test('real client startup deadline and cancellation against a stalled loopback socket', { timeout: 15000 }, async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `redis://127.0.0.1:${server.address().port}`;
    try {
      for (const role of ['producer', 'consumer', 'combined']) {
        await assert.rejects(createValhallaQueueEngine({ redisUrl: url, role, startupTimeoutMs: 100 }), /startup_timeout/);
        await until(() => sockets.size === 0);
        const controller = new AbortController();
        const pending = createValhallaQueueEngine({ redisUrl: url, role, signal: controller.signal });
        await until(() => sockets.size === (role === 'combined' ? 2 : 1));
        controller.abort();
        await assert.rejects(pending, /startup_cancelled/);
        await until(() => sockets.size === 0);
      }
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
    await withCleanup(t, async () => {
      const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      ], { encoding: 'utf8' });
      assert.equal(generated.status, 0, 'fixture certificate generation failed');
      redis = await startRedis(dir, port, true, t);
      const ca = path.join(dir, 'cert.pem');
      const url = `rediss://127.0.0.1:${port}`;
      const child = workerProcess(url, { production: true, ca });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      await withCleanup(t, async () => {
        await until(() => {
          if (childErrors.get(child).error || child.exitCode !== null || child.signalCode !== null) throw new Error('tls_worker_start_failed');
          return output.includes('"ready":true');
        });
        assert.equal((await stopChild(child))[0], 0);
        assert.match(output, /"ready":false/);
      }, [() => stopChild(child)]);

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
    }, [() => stopChild(redis), () => fs.rmSync(dir, { recursive: true, force: true })]);
  });

async function stopChild(child, signal = 'SIGTERM') {
  if (!child) return;
  const record = childErrors.get(child);
  const exited = () => child.pid && (child.exitCode !== null || child.signalCode !== null);
  try {
    if (exited()) return [child.exitCode, child.signalCode];
    if (record?.error && !child.pid) throw new Error('fixture_cleanup_failed: spawn failed', { cause: record.error });
    return await new Promise((resolve, reject) => {
      let timer;
      let lastError;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        if (error) reject(error);
        else resolve([child.exitCode, child.signalCode]);
      };
      const onExit = () => finish();
      const onError = (error) => {
        lastError = error;
        if (!child.pid) finish(new Error('fixture_cleanup_failed: spawn failed', { cause: error }));
      };
      const send = (name) => {
        try {
          if (!child.kill(name)) lastError = new Error(`signal ${name} was not sent`);
        } catch (error) {
          lastError = error;
        }
        if (exited()) finish();
      };
      child.on('exit', onExit);
      child.on('error', onError);
      if (exited()) return finish();
      timer = setTimeout(() => {
        if (exited()) return finish();
        send('SIGKILL');
        if (!settled) {
          timer = setTimeout(() => {
            if (exited()) return finish();
            finish(new Error('fixture_cleanup_failed: termination unconfirmed after SIGKILL', { cause: lastError }));
          }, 2000);
        }
      }, 2000);
      send(signal);
    });
  } finally {
    if (record) {
      child.removeListener('error', record.onError);
      childErrors.delete(child);
    }
  }
}

function workerProcess(url, extra = {}) {
  return spawnFixture(process.execPath, ['valhallaWorker.js'], {
    cwd: __dirname,
    env: {
      PATH: process.env.PATH, NODE_ENV: extra.production ? 'production' : 'test',
      VALHALLA_QUEUE_ENABLED: 'true', VALHALLA_QUEUE_ROLE: 'consumer',
      VALHALLA_EXECUTION_MODE: 'paper', REDIS_URL: url,
      ...(extra.ca ? { NODE_EXTRA_CA_CERTS: extra.ca } : {}),
    },
  });
}

test('fixture child cleanup is bounded and removes its observers and timers', { timeout: 15000 }, async (t) => {
  async function readyChild(ignoreTerm = false) {
    const child = spawnFixture(process.execPath, ['-e',
      `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} console.log('ready'); setInterval(() => {}, 1000);`]);
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    try {
      await until(() => output.includes('ready') || childErrors.get(child).error);
      assert.match(output, /ready/);
    } catch (error) {
      try { await stopChild(child); } catch (cleanupError) { t.diagnostic(`cleanup failed: ${cleanupError.message}`); }
      throw error;
    }
    return child;
  }
  async function measuredStop(child, expectedSignal) {
    const exitListeners = child.listenerCount('exit');
    const timers = [];
    const hook = createHook({ init(id, type, trigger, resource) {
      if (type === 'Timeout') timers.push(resource);
    } });
    hook.enable();
    const start = performance.now();
    try {
      assert.deepEqual(await stopChild(child), [null, expectedSignal]);
    } finally {
      hook.disable();
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5000, `cleanup took ${elapsed}ms`);
    if (expectedSignal === 'SIGKILL') assert.ok(elapsed >= 1900, `escalated too early: ${elapsed}ms`);
    assert.ok(timers.every((timer) => timer._destroyed));
    assert.equal(child.listenerCount('exit'), exitListeners);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.signalCode, expectedSignal);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }

  const normal = await readyChild();
  await withCleanup(t, () => measuredStop(normal, 'SIGTERM'), [() => stopChild(normal)]);
  const start = performance.now();
  assert.deepEqual(await stopChild(normal), [null, 'SIGTERM']);
  assert.ok(performance.now() - start < 200);

  const stubborn = await readyChild(true);
  await withCleanup(t, () => measuredStop(stubborn, 'SIGKILL'), [() => stopChild(stubborn)]);

  const signalFailure = await readyChild();
  const kill = signalFailure.kill;
  await withCleanup(t, async () => {
    signalFailure.kill = (signal) => {
      if (signal === 'SIGTERM') throw new Error('injected_signal_failure');
      return kill.call(signalFailure, signal);
    };
    await measuredStop(signalFailure, 'SIGKILL');
  }, [() => { signalFailure.kill = kill; }, () => stopChild(signalFailure)]);

  const failed = spawnFixture(path.join(os.tmpdir(), `missing-valhalla-${process.pid}`));
  await assert.rejects(stopChild(failed), /fixture_cleanup_failed: spawn failed/);
  assert.equal(failed.listenerCount('exit'), 0);
  assert.equal(failed.listenerCount('error'), 0);

  const delayedFailure = spawnFixture(path.join(os.tmpdir(), `missing-valhalla-${process.pid}`));
  await until(() => childErrors.get(delayedFailure).error);
  await assert.rejects(stopChild(delayedFailure), /fixture_cleanup_failed: spawn failed/);
  assert.equal(delayedFailure.listenerCount('error'), 0);
});

test('fixture cleanup escalates after signal errors and reports unconfirmed termination', { timeout: 15000 }, async (t) => {
  const child = spawnFixture(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000);"]);
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  const kill = child.kill;
  await withCleanup(t, async () => {
    await until(() => output.includes('ready'));
    child.kill = () => { throw new Error('injected_signal_failure'); };
    const timers = [];
    const hook = createHook({ init(id, type, trigger, resource) {
      if (type === 'Timeout') timers.push(resource);
    } });
    const start = performance.now();
    hook.enable();
    try {
      await assert.rejects(stopChild(child), /fixture_cleanup_failed: termination unconfirmed after SIGKILL/);
    } finally {
      hook.disable();
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 3900 && elapsed < 5500, `cleanup took ${elapsed}ms`);
    assert.ok(timers.every((timer) => timer._destroyed));
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  }, [() => { child.kill = kill; }, () => stopChild(child)]);

  const primary = new Error('original failure');
  const diagnostics = [];
  let remainingCleaned = false;
  await assert.rejects(withCleanup({ diagnostic: (message) => diagnostics.push(message) },
    () => { throw primary; },
    [() => { throw new Error('teardown failure'); }, () => { remainingCleaned = true; }]),
  (error) => error === primary);
  assert.equal(remainingCleaned, true);
  assert.match(diagnostics[0], /teardown failure/);
});

test('producer rejects a disconnect after readiness and reconnects', { skip: !binary, timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-race-'));
  const port = await unusedPort();
  const url = `redis://127.0.0.1:${port}`;
  let redis;
  let engine;
  let interrupt = true;
  class DisconnectingQueue extends Queue {
    add(...args) {
      if (interrupt) {
        interrupt = false;
        this.opts.connection.connector.stream.destroy();
      }
      return super.add(...args);
    }
  }
  await withCleanup(t, async () => {
    redis = await startRedis(dir, port, false, t);
    engine = await createValhallaQueueEngine({ redisUrl: url, role: 'producer', QueueClass: DisconnectingQueue });
    const start = performance.now();
    await assert.rejects(engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' }));
    assert.ok(performance.now() - start < 7000);
    await until(() => !engine.getStatus().ready);
    await until(() => engine.getStatus().ready, 15000);
    assert.ok((await engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' })).id);
  }, [() => engine?.close(), () => stopChild(redis), () => fs.rmSync(dir, { recursive: true, force: true })]);
});

test('producer command timeout bounds enqueue to an unresponsive connected Redis', { skip: !binary, timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-stall-'));
  const port = await unusedPort();
  const url = `redis://127.0.0.1:${port}`;
  let redis;
  let engine;
  let queue;
  await withCleanup(t, async () => {
    redis = await startRedis(dir, port, false, t);
    engine = await createValhallaQueueEngine({ redisUrl: url, role: 'producer' });
    redis.kill('SIGSTOP');
    const start = performance.now();
    await assert.rejects(engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' }), /Command timed out/);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 8000, `timeout took ${elapsed}ms`);
    assert.equal(engine.getStatus().ready, false);
    await assert.rejects(engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' }), /queue_unavailable/);
    redis.kill('SIGCONT');
    queue = new Queue('valhalla-zeus', { connection: { host: '127.0.0.1', port } });
    queue.on('error', () => {});
    await queue.waitUntilReady();
    await until(async () => (await queue.getWaitingCount()) === 1);
    assert.equal(await queue.getWaitingCount(), 1);
    await until(() => engine.getStatus().ready, 15000);
    assert.ok((await engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' })).id);
  }, [() => redis?.kill('SIGCONT'), () => queue?.close(), () => engine?.close(),
    () => stopChild(redis), () => fs.rmSync(dir, { recursive: true, force: true })]);
});

test('combined role separates clients and consumers persist through repeated reconnects', { skip: !binary, timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-combined-'));
  const port = await unusedPort();
  const url = `redis://127.0.0.1:${port}`;
  const clients = [];
  let redis;
  let engine;
  class TrackingRedis extends Redis {
    constructor(...args) {
      super(...args);
      this.reconnects = 0;
      this.on('reconnecting', () => { this.reconnects++; });
      clients.push(this);
    }
  }
  await withCleanup(t, async () => {
    redis = await startRedis(dir, port, false, t);
    engine = await createValhallaQueueEngine({ redisUrl: url, role: 'combined', RedisClient: TrackingRedis });
    assert.equal(clients.length, 2);
    assert.notEqual(clients[0], clients[1]);
    assert.equal(clients[0].options.maxRetriesPerRequest, 1);
    assert.equal(clients[1].options.maxRetriesPerRequest, null);
    assert.equal(engine.getStatus().ready, true);
    await stopChild(redis);
    redis = null;
    await until(() => !engine.getStatus().ready);
    await until(() => clients[1].reconnects >= 3, 10000);
    redis = await startRedis(dir, port, false, t);
    await until(() => engine.getStatus().ready, 15000);
    assert.ok((await engine.enqueue({ targetEngine: 'zeus', taskName: 'health-check' })).id);
    await engine.close();
    engine = null;
    await until(() => clients.every((client) => client.status === 'end'));
  }, [() => engine?.close(), () => stopChild(redis), () => fs.rmSync(dir, { recursive: true, force: true })]);
});

test('isolated real Redis integration, lifecycle and bounded load', { skip: !binary, timeout: 60000 }, async (t) => {
  assert.ok(path.isAbsolute(binary));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-redis-test-'));
  const port = await unusedPort();
  const url = `redis://127.0.0.1:${port}`;
  let redis;
  let producer;
  let consumer;
  const events = [];
  const queues = [];
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
  await withCleanup(t, async () => {
    redis = await startRedis(dir, port, false, t);
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
      events.push(event);
      await event.waitUntilReady();
    }
    for (const name of ['zeus', 'gorgo', 'cerberus']) {
      const queue = new Queue(`valhalla-${name}`, { connection: { host: '127.0.0.1', port } });
      queue.on('error', () => {});
      queues.push(queue);
    }
    await withCleanup(t, async () => {
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
    }, [...queues.map((queue) => () => queue.close()), ...events.map((event) => () => event.close())]);
    await stopChild(redis);
    await until(() => !producer.getStatus().ready && !consumer.getStatus().ready);
    redis = await startRedis(dir, port, false, t);
    await until(() => producer.getStatus().ready && consumer.getStatus().ready, 15000);
    const restoredEvents = new QueueEvents('valhalla-zeus', { connection: { host: '127.0.0.1', port } });
    restoredEvents.on('error', () => {});
    await withCleanup(t, async () => {
      await restoredEvents.waitUntilReady();
      const restored = await producer.enqueue({ targetEngine: 'zeus', taskName: 'health-check' });
      assert.equal((await restored.waitUntilFinished(restoredEvents, 5000)).status, 'observed');
    }, [() => restoredEvents.close()]);
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
      await withCleanup(t, async () => {
        await until(() => {
          if (childErrors.get(child).error || child.exitCode !== null || child.signalCode !== null) throw new Error('worker_start_failed');
          return output.includes('"ready":true');
        });
        const [code, signalCode] = await stopChild(child, signal);
        assert.equal(code, 0);
        assert.equal(signalCode, null);
        assert.match(output, /"ready":false/);
      }, [() => stopChild(child)]);
    }
    t.diagnostic('SIGTERM and SIGINT closed active consumer processes');
  }, [() => withCleanup(t, async () => {}, [
    ...queues.map((queue) => () => queue.close()), ...events.map((event) => () => event.close()),
  ]),
    () => consumer?.close(), () => producer?.close(), () => stopChild(redis),
    () => fs.rmSync(dir, { recursive: true, force: true })]);
});
