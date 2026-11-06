'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, executeShiftingInference } = require('./shifting_staircase_router');

const ok = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('falls back to the next model on failure', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    return model === 'a' ? { ok: false, status: 500 } : ok('hi');
  };
  const result = await executeShiftingInference('p', 's', 'k', {
    breaker: new CircuitBreaker(),
    fetchImpl,
    models: ['a', 'b'],
  });
  assert.deepEqual(result, { content: 'hi', modelUsed: 'b' });
  assert.deepEqual(calls, ['a', 'b']);
});

test('opens circuit after 3 failures in 60s and skips for 5 minutes', async () => {
  let clock = 0;
  const breaker = new CircuitBreaker({ now: () => clock });
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    calls.push(model);
    return model === 'a' ? { ok: false, status: 500 } : ok('x');
  };
  const run = () => executeShiftingInference('p', 's', 'k', { breaker, fetchImpl, models: ['a', 'b'] });
  for (let i = 0; i < 3; i++) { await run(); clock += 1000; }
  assert.equal(breaker.isOpen('a'), true);
  calls.length = 0;
  await run();
  assert.deepEqual(calls, ['b']);
  clock += 5 * 60 * 1000;
  assert.equal(breaker.isOpen('a'), false);
});

test('failures outside the 60s window do not trip the circuit', () => {
  let clock = 0;
  const breaker = new CircuitBreaker({ now: () => clock });
  breaker.recordFailure('a');
  clock += 40000;
  breaker.recordFailure('a');
  clock += 40000;
  breaker.recordFailure('a');
  assert.equal(breaker.isOpen('a'), false);
});
