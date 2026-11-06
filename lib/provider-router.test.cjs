'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRoute, selectRoute } = require('./provider-router');

const SECRET = 'super-secret-byok-value';
const budget = { remainingUsd: 1, callUsd: 0.01 };

function base(overrides = {}) {
  return {
    role: 'odin',
    capability: 'reasoning',
    prompt: 'Summarize the paper desk.',
    runtime: 'local-pc',
    localPcAwake: true,
    budget,
    secrets: { DEEPSEEK_API_KEY: SECRET, GEMINI_API_KEY: SECRET },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('awake local PC routes Odin voice to loopback Ollama and does not send the cloud key', async () => {
  const calls = [];
  const result = await executeRoute(base({ capability: 'voice' }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ message: { content: 'Local voice reply.' } });
    },
  });
  assert.equal(result.route, 'ollama');
  assert.equal(result.providerState, 'responded');
  assert.equal(result.content, 'Local voice reply.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers['x-goog-api-key'], undefined);
  assert.equal(JSON.stringify(calls[0].options.body).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('a cloud or Render runtime never calls Ollama, including a loopback URL', async () => {
  const calls = [];
  const result = await executeRoute(base({
    runtime: 'render',
    localPcAwake: true,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ choices: [{ message: { content: 'Cloud reasoning.' } }] });
    },
  });
  assert.equal(result.route, 'deepseek');
  assert.equal(result.fallbackFrom, 'runtime_not_local');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].url.includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('a non-loopback Ollama address is rejected and the cloud provider is used', async () => {
  const calls = [];
  const result = await executeRoute(base({
    capability: 'voice',
    ollamaBaseUrl: 'https://ollama.example.onrender.com',
  }), {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.authorization, goog: options.headers['x-goog-api-key'] });
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'Gemini voice.' }] } }],
      });
    },
  });
  assert.equal(result.route, 'gemini');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(calls[0].url.includes(SECRET), false);
  assert.equal(calls[0].goog, SECRET);
  assert.equal(calls[0].authorization, undefined);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('an asleep local PC skips Ollama and uses the cloud fallback', async () => {
  const urls = [];
  const result = await executeRoute(base({ localPcAwake: false }), {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'Fallback reasoning.' } }] });
    },
  });
  assert.deepEqual(urls, ['https://api.deepseek.com/chat/completions']);
  assert.equal(result.route, 'deepseek');
  assert.equal(result.content, 'Fallback reasoning.');
  assert.equal(result.fallbackFrom, 'local_pc_asleep');
});

test('Ollama failure falls back once to the cloud provider', async () => {
  const urls = [];
  const result = await executeRoute(base(), {
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (urls.length === 1) return jsonResponse({ error: 'down' }, 503);
      return jsonResponse({ choices: [{ message: { content: 'Cloud after local failure.' } }] });
    },
  });
  assert.deepEqual(urls, [
    'http://127.0.0.1:11434/api/chat',
    'https://api.deepseek.com/chat/completions',
  ]);
  assert.equal(result.route, 'deepseek');
  assert.equal(result.content, 'Cloud after local failure.');
  assert.equal(result.chargedUsd, 0.01);
});

test('a missing provider or empty provider body is unavailable and is not filled in', async () => {
  const asleep = await executeRoute(base({
    localPcAwake: false,
    secrets: {},
  }), {
    fetchImpl: async () => {
      throw new Error(`unexpected call with ${SECRET}`);
    },
  });
  assert.equal(asleep.status, 'unavailable');
  assert.equal(asleep.reason, 'provider_missing');
  assert.equal(asleep.content, null);
  assert.equal(asleep.providerState, 'unavailable');
  assert.equal(JSON.stringify(asleep).includes('healthy'), false);

  let calls = 0;
  const empty = await executeRoute(base({ localPcAwake: false }), {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: '   ' } }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.reason, 'provider_unavailable');
  assert.equal(empty.content, null);
  assert.equal(empty.chargedUsd, 0);
});

test('provider errors and thrown network failures stay unavailable and do not leak the key', async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const thrown = await executeRoute(base({ localPcAwake: false }), {
      fetchImpl: async () => {
        throw new Error(`connect failed Authorization Bearer ${SECRET}`);
      },
    });
    assert.equal(thrown.status, 'unavailable');
    assert.equal(thrown.content, null);
    assert.equal(JSON.stringify(thrown).includes(SECRET), false);
    assert.equal(logs.some((line) => line.includes(SECRET)), false);
  } finally {
    console.error = original;
  }
});

test('budget and quota failures do not call a provider', async () => {
  const cases = [
    { remainingUsd: 0, callUsd: 0.01 },
    { remainingUsd: 0.001, callUsd: 0.01 },
    { remainingUsd: Number.NaN, callUsd: 0.01 },
    { remainingUsd: 1, callUsd: 0 },
    null,
  ];
  for (const item of cases) {
    let calls = 0;
    const result = await executeRoute(base({ budget: item }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: 'should not run' } }] });
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'budget_exhausted');
    assert.equal(result.content, null);
  }
});

test('Thalos accepts paper and view only and never reports live execution', async () => {
  const paper = await executeRoute(base({ role: 'thalos', capability: 'paper', localPcAwake: false }), {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /Paper and view only/);
      return jsonResponse({ choices: [{ message: { content: 'View of the paper book.' } }] });
    },
  });
  assert.equal(paper.mode, 'paper');
  assert.equal(paper.liveExecution, false);
  assert.equal(paper.content, 'View of the paper book.');

  let calls = 0;
  for (const capability of ['trade', 'live', 'sign', 'withdraw']) {
    const refused = await executeRoute(base({ role: 'thalos', capability }), {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: 'filled' } }] });
      },
    });
    assert.equal(refused.status, 'unavailable');
    assert.equal(refused.reason, 'capability_unavailable');
    assert.equal(refused.liveExecution, false);
  }
  assert.equal(calls, 0);
});

test('route selection does not copy a secret into the decision object', () => {
  const decision = selectRoute(base({ runtime: 'render', localPcAwake: false }));
  assert.equal(decision.route, 'deepseek');
  assert.equal(decision.providerState, 'not_probed');
  assert.equal(Object.hasOwn(decision, 'secrets'), false);
  assert.equal(JSON.stringify(decision).includes(SECRET), false);
  assert.equal(JSON.stringify(decision).includes('healthy'), false);
});
