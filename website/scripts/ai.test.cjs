const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleAi, resetAiLimits, DEFAULT_MODEL, FALLBACK_MODEL, MAX_TOKENS } = require('./ai-core.cjs');

const root = path.join(__dirname, '../..');

function supabase(ok) {
  return { ok: ok, json: async () => (ok ? { id: 'user-1' } : {}) };
}

function ask(message, model) {
  return JSON.stringify(model ? { message: message, model: model } : { message: message });
}

test('a missing OpenRouter key returns AI not configured and never calls OpenRouter', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What is valOS?')
  }, {}, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'no' } }] }) };
  }, 1_000);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'AI not configured' });
  assert.equal(calls.some(url => url.includes('openrouter')), false);
});

test('the assistant requires a Supabase session', async () => {
  resetAiLimits();
  const missing = await handleAi({ method: 'POST', headers: {}, body: ask('Hello') }, { OPENROUTER_API_KEY: 'server-only-key' }, async () => { throw new Error('no'); }, 2_000);
  assert.equal(missing.status, 401);
  const rejected = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer bad' },
    body: ask('Hello')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async () => supabase(false), 3_000);
  assert.equal(rejected.status, 401);
});

test('a non-free model is rejected before any completion call', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('Hello', 'openai/gpt-4o')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: true, json: async () => ({}) };
  }, 4_000);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Model not allowed.');
  assert.equal(calls.some(url => url.includes('openrouter')), false);
});

test('assistant requests are limited per signed-in user', async () => {
  resetAiLimits();
  const env = { OPENROUTER_API_KEY: 'server-only-key' };
  const fetchImpl = async (url) => String(url).includes('/auth/v1/user')
    ? supabase(true)
    : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  let limited = null;
  for (let i = 0; i < 7; i += 1) {
    limited = await handleAi({ method: 'POST', headers: { authorization: 'Bearer good' }, body: ask('Hello') }, env, fetchImpl, 10_000);
  }
  assert.equal(limited.status, 429);
});

test('a free-model failure falls back to the other free model and hides the key', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What can you do?')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url, init) => {
    calls.push({ url: String(url), init: init });
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    const body = JSON.parse(init.body);
    assert.equal(body.model.endsWith(':free'), true);
    assert.equal(body.max_tokens, MAX_TOKENS);
    assert.equal(init.headers['HTTP-Referer'], 'https://valhalla-app.xyz');
    assert.equal(init.headers['X-Title'], 'ValhallaOS');
    assert.match(body.messages[0].content, /do not give financial advice/i);
    assert.match(body.messages[0].content, /do not know/i);
    if (body.model === DEFAULT_MODEL) return { ok: false, json: async () => ({ error: 'busy' }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'I can explain the desk. I do not trade.' } }] }) };
  }, 5_000);
  assert.equal(result.status, 200);
  assert.equal(result.body.model, FALLBACK_MODEL);
  assert.equal(result.body.reply.includes('server-only-key'), false);
  const models = calls.filter(call => call.url.includes('openrouter')).map(call => JSON.parse(call.init.body).model);
  assert.deepEqual(models, [DEFAULT_MODEL, FALLBACK_MODEL]);
});

test('the desk says the assistant is not connected until a reply arrives', () => {
  const html = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'website/os/ai.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api/ai.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'website/scripts/ai-core.cjs'), 'utf8');
  assert.match(html, /Assistant not connected/);
  assert.match(client, /Assistant not connected/);
  assert.match(client, /Sign-in required/);
  assert.match(client, /Too many assistant requests/);
  assert.doesNotMatch(client, /OPENROUTER_API_KEY|openrouter\.ai/);
  assert.match(api, /process\.env/);
  assert.match(core, /env\.OPENROUTER_API_KEY/);
  assert.doesNotMatch(core + api, /OPENROUTER_API_KEY\s*=\s*['"][^'"]+['"]/);
  assert.match(core, /:free/);
});
