'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(isAuthorizedDispatch('Bearer correct-token-0123456789-abcdefghijklmnop', 'correct-token-0123456789-abcdefghijklmnop'), true);
  assert.equal(isAuthorizedDispatch('Bearer wrong-token', 'correct-token-0123456789-abcdefghijklmnop'), false);
  assert.equal(isAuthorizedDispatch('Bearer correct-token-0123456789-abcdefghijklmnop', ''), false);
  assert.equal(isAuthorizedDispatch(undefined, 'correct-token-0123456789-abcdefghijklmnop'), false);
});

test('requires a Redis protocol URL and rejects insecure production Redis', async () => {
  await assert.rejects(
    createValhallaQueueEngine({ redisUrl: 'https://redis.example.test' }),
    /REDIS_URL must use rediss:\/\/ in production/,
  );
});

test('skips jobs already marked processed in Redis', async () => {
  const store = new Map();
  let handler;
  class FakeRedis {
    async ping() {}
    async get(key) { return store.get(key) ?? null; }
    async set(key, value, mode, ttl) { store.set(key, { value, mode, ttl }); }
    async quit() {}
    on() {}
  }
  class FakeQueue { on() {} async close() {} }
  class FakeWorker {
    constructor(name, fn) { if (name === 'valhalla-zeus') handler = fn; }
    on() {}
    async close() {}
  }
  const engine = await createValhallaQueueEngine({
    redisUrl: 'redis://localhost:6379',
    RedisClient: FakeRedis,
    QueueClass: FakeQueue,
    WorkerClass: FakeWorker,
  });
  const job = { id: '42', name: 'health-check', data: { payload: {} } };
  assert.deepEqual(await handler(job), { status: 'observed', mode: 'paper' });
  assert.equal(store.get('job:processed:zeus:42').ttl, 86400);
  assert.deepEqual(await handler(job), { status: 'SKIPPED_DUPLICATE' });
  await engine.close();
});
