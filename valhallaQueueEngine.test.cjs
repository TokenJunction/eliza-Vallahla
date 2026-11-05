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
