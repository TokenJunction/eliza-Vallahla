'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createValhallaQueueEngine,
  executeSafeTask,
  isAuthorizedDispatch,
  validateDispatch,
} = require('./valhallaQueueEngine');

test('accepts only explicitly allow-listed paper and status jobs', () => {
  assert.deepEqual(
    validateDispatch({
      targetEngine: 'gorgo',
      taskName: 'paper-simulation',
      payload: { scenario: 'baseline' },
    }),
    {
      targetEngine: 'gorgo',
      taskName: 'paper-simulation',
      payload: { scenario: 'baseline' },
    },
  );
  assert.deepEqual(executeSafeTask('cerberus', 'vault-check', {}), {
    status: 'blocked',
    vaultLocked: true,
  });
});

test('rejects trading, arbitrary task names, and secret-shaped payload fields', () => {
  assert.throws(
    () => validateDispatch({ targetEngine: 'cerberus', taskName: 'trade' }),
    /unsupported_queue_task/,
  );
  assert.throws(
    () =>
      validateDispatch({
        targetEngine: 'zeus',
        taskName: 'health-check',
        payload: { privateKey: 'must-not-be-queued' },
      }),
    /unsupported_payload_field/,
  );
  assert.throws(
    () =>
      validateDispatch({
        targetEngine: 'gorgo',
        taskName: 'paper-simulation',
        payload: { scenario: 'arbitrary-code' },
      }),
    /unsupported_paper_scenario/,
  );
});

test('requires a bearer service token and compares it safely', () => {
  assert.equal(isAuthorizedDispatch('Bearer correct-token', 'correct-token'), true);
  assert.equal(isAuthorizedDispatch('Bearer wrong-token', 'correct-token'), false);
  assert.equal(isAuthorizedDispatch('Bearer correct-token', ''), false);
  assert.equal(isAuthorizedDispatch(undefined, 'correct-token'), false);
});

test('requires a Redis protocol URL and rejects insecure production Redis', async () => {
  await assert.rejects(
    createValhallaQueueEngine({ redisUrl: 'https://redis.example.test' }),
    /REDIS_URL must use rediss:\/\/ in production/,
  );
});

test('role-specific clients wait for readiness and are all closed', async () => {
  for (const role of ['producer', 'consumer', 'combined']) {
    const clients = [];
    const queues = [];
    const workers = [];
    class Client extends EventEmitter {
      constructor(url, options) {
        super();
        this.options = options;
        this.status = 'connecting';
        clients.push(this);
        setImmediate(() => { this.status = 'ready'; this.emit('ready'); });
      }
      ping() {
        assert.equal(this.status, 'ready');
        return Promise.resolve('PONG');
      }
      disconnect() { this.status = 'end'; this.emit('end'); }
    }
    class Queue extends EventEmitter {
      constructor(name, { connection }) {
        super();
        assert.equal(connection.status, 'ready');
        this.connection = connection;
        queues.push(this);
      }
      waitUntilReady() { return Promise.resolve(); }
      close() { this.closed = true; return Promise.resolve(); }
    }
    class Worker extends EventEmitter {
      constructor(name, processor, { connection }) {
        super();
        this.connection = connection;
        this.blocking = new EventEmitter();
        this.blocking.status = 'ready';
        workers.push(this);
      }
      waitUntilReady() { return Promise.resolve(); }
      getBackend() { return { blockingConnection: { client: Promise.resolve(this.blocking) } }; }
      run() { this.running = true; return Promise.resolve(); }
      isRunning() { return this.running; }
      close() { this.closed = true; return Promise.resolve(); }
    }
    const engine = await createValhallaQueueEngine({
      redisUrl: 'redis://127.0.0.1:6379', role, RedisClient: Client, QueueClass: Queue, WorkerClass: Worker,
    });
    assert.equal(clients.length, role === 'combined' ? 2 : 1);
    const producer = role === 'consumer' ? null : clients[0];
    const consumer = role === 'producer' ? null : clients.at(-1);
    if (producer) {
      assert.equal(producer.options.maxRetriesPerRequest, 1);
      assert.equal(producer.options.enableOfflineQueue, false);
      assert.equal(producer.options.autoResendUnfulfilledCommands, false);
      assert.equal(producer.options.commandTimeout, 5000);
      assert.ok(queues.every((queue) => queue.connection === producer));
    }
    if (consumer) {
      assert.equal(consumer.options.maxRetriesPerRequest, null);
      assert.equal(consumer.options.commandTimeout, undefined);
      assert.equal(consumer.options.enableOfflineQueue, undefined);
      assert.equal(consumer.options.retryStrategy(100), 15000);
      assert.ok(workers.every((worker) => worker.connection === consumer));
    }
    if (producer && consumer) assert.notEqual(producer, consumer);
    assert.equal(engine.getStatus().ready, true);
    for (const client of clients) {
      client.status = 'reconnecting';
      client.emit('close');
      assert.equal(engine.getStatus().ready, false);
      client.status = 'ready';
      client.emit('ready');
      assert.equal(engine.getStatus().ready, true);
    }
    await engine.close();
    assert.ok(clients.every((client) => client.status === 'end'));
    assert.ok([...queues, ...workers].every((item) => item.closed));
    assert.equal(engine.getStatus().ready, false);
  }
});

test('partial startup failure closes every created client and queue', async () => {
  const clients = [];
  const queues = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      this.status = 'ready';
      clients.push(this);
    }
    ping() { return Promise.resolve('PONG'); }
    disconnect() { this.status = 'end'; this.emit('end'); }
  }
  class Queue extends EventEmitter {
    constructor() {
      super();
      if (queues.length === 1) throw new Error('injected_failure');
      queues.push(this);
    }
    close() { this.closed = true; return Promise.resolve(); }
  }
  await assert.rejects(createValhallaQueueEngine({
    redisUrl: 'redis://127.0.0.1:6379', role: 'combined', RedisClient: Client, QueueClass: Queue,
  }), /redis_unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients.length, 2);
  assert.ok(clients.every((client) => client.status === 'end'));
  assert.equal(queues[0].closed, true);
});
