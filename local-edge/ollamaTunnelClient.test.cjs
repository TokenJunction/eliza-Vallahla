'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GENERATE_URL,
  CHAT_URL,
  TAGS_URL,
  MAX_BODY_BYTES,
  DEFAULT_LOCAL_TIMEOUT_MS,
  runLocalGenerate,
  runLocalChat,
  listLocalModels,
  parseGenerateBody,
} = require('./ollamaTunnelClient');

const model = 'qwen2.5-coder:14b';

function streamFrom(parts) {
  const chunks = parts.map((part) => Buffer.from(part));
  return {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() { this.cancelled = true; },
      };
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] || null; } },
    body: streamFrom([text]),
  };
}

function allow(request) {
  return { ok: request.model === model && request.path === '/api/generate', model: request.model };
}

function baseInput(fetchImpl, over = {}) {
  return Object.assign({
    model,
    prompt: 'Say hi',
    stream: false,
    options: { num_predict: 16, temperature: 0 },
    allowlistCheck: allow,
    fetchImpl,
    timeoutMs: 1000,
    localTimeoutMs: DEFAULT_LOCAL_TIMEOUT_MS,
  }, over);
}

test('generate posts only to the loopback generate path and accepts the word no', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ response: 'no', done: true });
  };
  let seen;
  const result = await runLocalGenerate(baseInput(fetchImpl, {
    allowlistCheck(request) {
      seen = request;
      return allow(request);
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.response, 'no');
  assert.equal(result.executedTools, false);
  assert.equal(result.roleRequired, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GENERATE_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['model', 'options', 'prompt', 'stream']);
  assert.equal(sent.stream, false);
  assert.equal(sent.model, model);
  assert.equal(seen.prompt, 'Say hi');
  assert.equal(seen.stream, false);
  assert.equal(seen.path, '/api/generate');
});

test('redirects, path overrides, sockets, and /etc never leave the fixed URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status: 302,
      ok: false,
      headers: { get: () => 'http://127.0.0.1/etc/passwd' },
      body: streamFrom(['']),
    };
  };
  const redirected = await runLocalGenerate(baseInput(fetchImpl));
  assert.equal(redirected.reason, 'redirect_refused');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GENERATE_URL);
  const blocked = [
    baseInput(fetchImpl, { model: 'unix-socket' }),
    baseInput(fetchImpl, { model: '/etc/passwd' }),
    baseInput(fetchImpl, { path: '/etc/hostname' }),
    baseInput(fetchImpl, { url: 'http://127.0.0.1:11434/socket' }),
    baseInput(fetchImpl, { path: '/api/chat' }),
  ];
  for (const input of blocked) {
    const result = await runLocalGenerate(input);
    assert.equal(result.ok, false);
  }
  assert.equal(calls.length, 1);
});

test('numeric caps reject an unlimited token default and keep temperature at 2', async () => {
  const fetchImpl = async () => { throw new Error('should_not_fetch'); };
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { temperature: 0 } }))).reason, 'num_predict_required');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: undefined } }))).reason, 'num_predict_required');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: 4097 } }))).reason, 'option_out_of_bounds:num_predict');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: 16, temperature: 2.1 } }))).reason, 'option_out_of_bounds:temperature');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: 16, num_ctx: 0 } }))).reason, 'option_out_of_bounds:num_ctx');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: 16, max_tokens: undefined } }))).reason, 'unlimited_max_tokens_rejected');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { options: { num_predict: 16, context: 1024 } }))).reason, 'option_not_allowed:context');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { stream: true }))).reason, 'stream_must_be_false');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { format: { note: 'x'.repeat(1100) } }))).reason, 'format_too_large');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { prompt: 'a'.repeat(MAX_BODY_BYTES + 1) }))).reason, 'prompt_too_large');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { prompt: 'a'.repeat(MAX_BODY_BYTES) }))).reason, 'body_too_large');
  assert.equal((await runLocalGenerate(baseInput(fetchImpl, { timeoutMs: DEFAULT_LOCAL_TIMEOUT_MS + 1 }))).reason, 'timeout_exceeds_local_config');
  const calls = [];
  const wider = await runLocalGenerate(baseInput(async (url) => {
    calls.push(String(url));
    return jsonResponse({ response: 'ok', done: true });
  }, { timeoutMs: 10_000, localTimeoutMs: 30_000, options: { num_predict: 4096, temperature: 2, num_ctx: 8192 } }));
  assert.equal(wider.ok, true);
  assert.equal(calls[0], GENERATE_URL);
});

test('whitespace is not a completion, done is required, and tool tags are inert', () => {
  assert.equal(parseGenerateBody('{"response":"   \\n","done":true}').reason, 'empty_generation');
  assert.equal(parseGenerateBody('{"response":"no","done":false}').reason, 'stream_incomplete');
  assert.equal(parseGenerateBody('{"message":{"role":"assistant","content":"hi"},"done":true}').reason, 'response_required');
  const tagged = parseGenerateBody('{"response":"no <tool>run</tool>","done":true,"tool_calls":[{"name":"shell"}]}');
  assert.equal(tagged.ok, true);
  assert.equal(tagged.executedTools, false);
  assert.equal(tagged.toolCalls[0].name, 'shell');
  assert.equal(parseGenerateBody('{"response":"hel","done":false}\n{"response":"lo","done":true}').response, 'hello');
  assert.equal(parseGenerateBody('{"response":"hi","done":true}\n{"response":"more","done":true}').reason, 'data_after_done');
  const listed = '{"models":[{"name":"qwen2.5-coder:14b"}]}';
  assert.equal(parseGenerateBody(listed).reason, 'listing_not_generation');
});

test('a model list is not generation and chat stays on /api/chat', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (String(url) === TAGS_URL) return jsonResponse({ models: [{ name: model }] });
    if (String(url) === CHAT_URL) return jsonResponse({ message: { role: 'assistant', content: 'chat-ok' }, done: true });
    throw new Error('unexpected_' + url);
  };
  const listed = await listLocalModels({ fetchImpl, timeoutMs: 1000, localTimeoutMs: 5000 });
  assert.equal(listed.ok, true);
  assert.equal(listed.verifiedGeneration, false);
  assert.deepEqual(listed.models, [model]);
  const chat = await runLocalChat({
    frame: {
      request: {
        path: '/api/chat',
        model,
        messages: [{ role: 'user', content: 'hello' }],
        options: { num_predict: 16 },
        stream: false,
      },
    },
    allowedModels: [model],
    fetchImpl,
    timeoutMs: 1000,
    localTimeoutMs: 30_000,
  });
  assert.equal(chat.ok, true);
  assert.equal(chat.content, 'chat-ok');
  assert.equal(chat.executedTools, false);
  const badRole = await runLocalChat({
    frame: { request: { path: '/api/chat', model, messages: [{ role: 'user', content: 'hello' }] } },
    allowedModels: [model],
    fetchImpl: async () => jsonResponse({ message: { role: 'user', content: 'nope' }, done: true }),
    timeoutMs: 1000,
  });
  assert.equal(badRole.reason, 'unexpected_role');
  assert.deepEqual(calls.map((call) => call.url), [TAGS_URL, CHAT_URL]);
});

test('response chunks stop at the byte cap and cancel does not invent a completion', async () => {
  const capped = await runLocalGenerate(baseInput(async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: streamFrom(['{"response":', '"hello hello"']),
  }), { maxResponseBytes: 8 }));
  assert.equal(capped.reason, 'response_too_large');
  const ctl = new AbortController();
  const pending = runLocalGenerate(baseInput((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    setTimeout(() => resolve(jsonResponse({ response: 'late', done: true })), 50);
  }), { signal: ctl.signal, timeoutMs: 5_000 }));
  ctl.abort();
  assert.equal((await pending).reason, 'cancelled');
});
