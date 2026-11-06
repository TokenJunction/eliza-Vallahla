'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentCrossTalkBus } = require('./agentCrossTalkBus');

function pair() {
  const sent = [];
  const publisher = { publish: async (_c, raw) => sent.push(raw) };
  const zeus = new AgentCrossTalkBus({ agent: 'zeus', publisher });
  const receiver = new AgentCrossTalkBus({ agent: 'gorgo', trustedKeys: { zeus: zeus.publicKey } });
  return { zeus, receiver, sent };
}

test('accepts a validly signed packet', async () => {
  const { zeus, receiver, sent } = pair();
  await zeus.broadcastAgentSignal('telemetry-sync', { a: 1 });
  const outcome = receiver.handleIncomingAgentSignal(sent[0]);
  assert.deepEqual(outcome, { agent: 'zeus', task: 'telemetry-sync', result: { status: 'synced', keys: 1 } });
});

test('drops tampered, unsigned, replayed and untrusted packets', async () => {
  const { zeus, receiver, sent } = pair();
  await zeus.broadcastAgentSignal('telemetry-sync', { a: 1 });
  const tampered = JSON.stringify({ ...JSON.parse(sent[0]), payload: { a: 2 } });
  assert.equal(receiver.handleIncomingAgentSignal(tampered), null);

  const { signature, ...unsigned } = JSON.parse(sent[0]);
  assert.equal(receiver.handleIncomingAgentSignal(JSON.stringify(unsigned)), null);

  assert.ok(receiver.handleIncomingAgentSignal(sent[0]));
  assert.equal(receiver.handleIncomingAgentSignal(sent[0]), null);

  const rogue = new AgentCrossTalkBus({ agent: 'zeus', publisher: { publish: async (_c, raw) => sent.push(raw) } });
  await rogue.broadcastAgentSignal('telemetry-sync', {});
  assert.equal(receiver.handleIncomingAgentSignal(sent.at(-1)), null);
});

test('drops stale packets and refuses non-allowlisted tasks', async () => {
  const { zeus, receiver, sent } = pair();
  await zeus.broadcastAgentSignal('pre-trade-validation', {});
  receiver.now = () => Date.now() + 60_000;
  assert.equal(receiver.handleIncomingAgentSignal(sent[0]), null);
  await assert.rejects(zeus.broadcastAgentSignal('execute-trade', {}), /unsupported_a2a_task/);
});
