'use strict';

const crypto = require('node:crypto');

const CHANNEL = 'valhalla:a2a:swarm_frequency';
const MAX_AGE_MS = 30_000;
const TASKS = Object.freeze({
  'pre-trade-validation': (payload) => ({ status: 'validated', paperOnly: true, symbol: payload?.symbol ?? null }),
  'telemetry-sync': (payload) => ({ status: 'synced', keys: Object.keys(payload || {}).length }),
});

// Canonical JSON (sorted keys) so signer and verifier hash identical bytes.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

class AgentCrossTalkBus {
  constructor({ agent, publisher, subscriber, trustedKeys = {}, now = Date.now } = {}) {
    if (!agent) throw new Error('agent required');
    this.agent = agent;
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.trustedKeys = new Map(Object.entries(trustedKeys));
    this.now = now;
    this.seen = new Map();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  trust(agent, publicKey) {
    this.trustedKeys.set(agent, publicKey);
  }

  async start() {
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel, raw) => this.handleIncomingAgentSignal(raw));
  }

  async broadcastAgentSignal(task, payload = {}) {
    if (!Object.hasOwn(TASKS, task)) throw new Error('unsupported_a2a_task');
    const body = { agent: this.agent, task, payload, ts: this.now(), nonce: crypto.randomUUID() };
    const signature = crypto.sign(null, Buffer.from(canonical(body)), this.privateKey).toString('base64');
    const raw = JSON.stringify({ ...body, signature });
    await this.publisher.publish(CHANNEL, raw);
    return raw;
  }

  // Returns the task outcome, or null when the packet is dropped.
  handleIncomingAgentSignal(raw) {
    try {
      const { signature, ...body } = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const key = this.trustedKeys.get(body.agent);
      if (!signature || !key || !Object.hasOwn(TASKS, body.task)) return null;
      if (!body.nonce || Math.abs(this.now() - body.ts) > MAX_AGE_MS) return null;
      const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(canonical(body)), publicKey, Buffer.from(signature, 'base64'))) return null;

      const id = `${body.agent}:${body.nonce}`;
      if (this.seen.has(id)) return null;
      this.seen.set(id, body.ts);
      for (const [k, ts] of this.seen) if (this.now() - ts > MAX_AGE_MS) this.seen.delete(k);

      return { agent: body.agent, task: body.task, result: TASKS[body.task](body.payload) };
    } catch {
      return null;
    }
  }
}

module.exports = { AgentCrossTalkBus, CHANNEL, TASKS, canonical };
