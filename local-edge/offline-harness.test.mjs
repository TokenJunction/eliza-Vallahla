import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createRelayServer, listenLoopback } from '../backend/wsRelayServer.js';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const {
  CAPABILITIES,
  createMemoryStore,
  createIdentityManager,
} = require('../lib/IdentityManager.js');
const { runLocalGenerate, GENERATE_URL } = require('./ollamaTunnelClient.js');

const TOKEN = 'device-auth-token-1';
const deviceId = 'dev-local-device-1';
const activeId = 'active-device-0001';
const model = 'qwen2.5-coder:14b';

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message_timeout')), 2000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

test('a granted local generate runs only after consume and a replay does not call the model', async () => {
  const state = { session: 1, deviceVersion: 4, active: true, device: true };
  const authDo = {
    available: true,
    sessionActive: (subject, tenantId) => state.active && subject === 'subject-1' && tenantId === 'tenant-1',
    deviceActive: (id, tenantId) => state.device && id === deviceId && tenantId === 'tenant-1',
    sessionVersion: () => state.session,
    deviceVersion: () => state.deviceVersion,
  };
  const identity = createIdentityManager({ production: false, store: createMemoryStore(), authDo });
  const adopted = identity.adoptVerifiedSession({
    active: true,
    subject: 'subject-1',
    tenantId: 'tenant-1',
    sessionVersion: 1,
    serverRole: 'member',
    roleSource: 'auth-do',
    role: 'owner',
    jupiter: true,
  });
  assert.equal(adopted.principal.jupiter, false);
  assert.equal(adopted.principal.capMicros, 0);
  const server = http.createServer();
  const calls = [];
  const relay = createRelayServer({
    server,
    production: false,
    allowDevLoopbackWs: true,
    manualClock: true,
    clock: { now: () => 50_000 },
    authenticate(token) {
      if (token !== TOKEN) return { ok: false };
      return { ok: true, subject: 'subject-1', tenantId: 'tenant-1', deviceId, activeId, sessionVersion: 1, deviceVersion: 4 };
    },
    fingerprintOf: (capability, request) => identity.requestFingerprint(capability, request),
    consumeGrant: (input) => identity.consumeGrant(input),
    releaseReservation: (info) => identity.releaseReservation('tenant-1', info.taskId),
  });
  assert.equal(server.listening, false);
  const address = await listenLoopback(relay);
  assert.equal(address.host, '127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/relay`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const helloPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    const hello = await helloPromise;
    assert.equal(hello.type, 'authenticated');
    assert.equal(JSON.stringify(hello).includes(TOKEN), false);
    const task = identity.selectTaskId();
    const request = {
      model,
      prompt: 'Say no',
      stream: false,
      options: { num_predict: 8, temperature: 0 },
    };
    const granted = identity.issueGrant({
      principal: adopted.principal,
      capability: CAPABILITIES.LOCAL_GENERATE,
      connection: {
        authenticated: true,
        active: true,
        tenantId: 'tenant-1',
        subject: 'subject-1',
        deviceId,
        connectionId: hello.connectionId,
        activeId,
        sessionVersion: 1,
        deviceVersion: 4,
      },
      taskId: task.taskId,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      request,
      now: 50_000,
      ttlMs: 30_000,
      deviceAllowlist: {
        active: true,
        tenantId: 'tenant-1',
        subject: 'subject-1',
        deviceId,
        models: [model],
        capabilities: [CAPABILITIES.LOCAL_GENERATE],
      },
    });
    assert.equal(granted.ok, true);
    const executePromise = nextMessage(ws);
    const dispatched = relay.dispatch({
      connectionId: hello.connectionId,
      grantId: granted.grant.grantId,
      nonce: granted.grant.nonce,
      capability: CAPABILITIES.LOCAL_GENERATE,
      taskId: task.taskId,
      activeId,
      deviceId,
      now: 50_000,
      request,
    });
    assert.equal(dispatched.modelInvoked, false);
    assert.equal(dispatched.dispatched, true);
    const execute = await executePromise;
    assert.equal(execute.type, 'execute');
    assert.equal(execute.request.stream, false);
    const generated = await runLocalGenerate({
      model: execute.request.model,
      prompt: execute.request.prompt,
      stream: false,
      options: execute.request.options,
      allowlistCheck(full) {
        assert.equal(full.path, '/api/generate');
        assert.equal(full.model, model);
        return { ok: true, model: full.model };
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        const payload = JSON.stringify({ response: 'no', done: true });
        const bytes = Buffer.from(payload);
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true };
                  sent = true;
                  return { done: false, value: bytes };
                },
                async cancel() {},
              };
            },
          },
        };
      },
      timeoutMs: 1000,
      localTimeoutMs: 30_000,
    });
    assert.equal(generated.ok, true);
    assert.equal(generated.response, 'no');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GENERATE_URL);
    assert.equal(calls[0].body.stream, false);
    ws.send(JSON.stringify({
      type: 'result',
      requestId: execute.requestId,
      seq: 0,
      done: true,
      content: generated.response,
      activeId,
      deviceId,
    }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('result_timeout')), 2000);
      const poll = () => {
        const outcome = relay.streamOutcome(hello.connectionId, execute.requestId);
        if (outcome.status === 'completed') {
          clearTimeout(timer);
          resolve(outcome);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    const replay = relay.dispatch({
      connectionId: hello.connectionId,
      grantId: granted.grant.grantId,
      nonce: granted.grant.nonce,
      capability: CAPABILITIES.LOCAL_GENERATE,
      taskId: task.taskId,
      activeId,
      deviceId,
      now: 50_100,
      request,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.modelInvoked, false);
    assert.equal(replay.reason, 'grant_already_running');
    assert.equal(calls.length, 1);
  } finally {
    ws.close();
    await relay.close();
  }
});
