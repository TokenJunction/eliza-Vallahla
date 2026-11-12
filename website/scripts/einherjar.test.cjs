const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { handleAi, resetAiLimits } = require('./ai-core.cjs');
const { sealByok, routeChat, resetProviderHealth, resetGpuSpend } = require('./einherjar-core.cjs');

const root = path.join(__dirname, '../..');

function user() {
  return { ok: true, json: async () => ({ id: 'user-1' }) };
}

function chat(status, content) {
  return { ok: status >= 200 && status < 300, status: status, json: async () => ({ choices: [{ message: { content: content || '' } }], usage: { total_tokens: 12 } }) };
}

function keys() {
  const sign = crypto.generateKeyPairSync('ed25519');
  const agree = crypto.generateKeyPairSync('x25519');
  return {
    signPrivate: sign.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    agreePublic: agree.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

test('a customer key is sealed with AES-256-GCM and is tried before the other providers', async () => {
  resetAiLimits();
  resetProviderHealth();
  const secret = 'sk-customer-only';
  const enc = crypto.randomBytes(32);
  const packed = sealByok(secret, enc);
  assert.equal(packed.includes(secret), false);
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: JSON.stringify({ message: 'What is the desk?' })
  }, {
    AI_BYOK_ENC_KEY: enc.toString('base64'),
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    HF_TOKEN: 'hf-test-token',
    OPENROUTER_API_KEY: 'or-test-key'
  }, async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return user();
    if (String(url).includes('/ai_byok')) return { ok: true, json: async () => ([{ provider: 'openai', ciphertext: packed }]) };
    if (String(url).includes('api.openai.com')) {
      assert.equal(init.headers.authorization, 'Bearer ' + secret);
      return chat(200, 'From the customer key.');
    }
    return chat(200, 'later');
  }, 20_000);
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'byok');
  assert.equal(result.body.reply, 'From the customer key.');
  assert.equal(JSON.stringify(result.body).includes(secret), false);
  assert.equal(calls.some(url => url.includes('huggingface') || url.includes('openrouter')), false);
  const source = fs.readFileSync(path.join(root, 'website/scripts/einherjar-core.cjs'), 'utf8');
  assert.match(source, /aes-256-gcm/);
  assert.doesNotMatch(source, /des-ede|3des/i);
});

test('402, 429, 500 and a timeout each fall through to the next provider', async () => {
  resetAiLimits();
  resetProviderHealth();
  resetGpuSpend();
  const pair = keys();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: JSON.stringify({ message: 'What can the desk do?' })
  }, {
    HF_TOKEN: 'hf-test-token',
    OPENROUTER_API_KEY: 'or-test-key',
    OVERSEER_NODE_URL: 'https://overseer.invalid/relay',
    RELAY_SIGN_PRIVATE: pair.signPrivate,
    OVERSEER_AGREE_PUBLIC: pair.agreePublic,
    GPU_NODE_URL: 'https://gpu.invalid',
    GPU_NODE_KEY: 'gpu-test-key',
    GPU_MONTHLY_CAP_USD: '3'
  }, async (url, init) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/auth/v1/user')) return user();
    if (target.includes('huggingface')) return chat(402, '');
    if (target.includes('openrouter')) return chat(429, '');
    if (target.includes('overseer.invalid')) {
      const packet = JSON.parse(init.body);
      assert.equal(typeof packet.sig, 'string');
      assert.equal(packet.box.includes('What can the desk do?'), false);
      return chat(500, '');
    }
    if (target.includes('gpu.invalid')) {
      assert.equal(init.headers.authorization, 'Bearer gpu-test-key');
      return chat(200, 'From the GPU node.');
    }
    return chat(500, '');
  }, 21_000);
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'gpu');
  assert.equal(result.body.reply, 'From the GPU node.');
  assert.equal(JSON.stringify(result.body).includes('gpu-test-key'), false);
  assert.equal(JSON.stringify(result.body).includes('hf-test-token'), false);
  assert.deepEqual(calls.filter(url => !url.includes('/auth/')), [
    'https://router.huggingface.co/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://overseer.invalid/relay',
    'https://gpu.invalid/v1/chat/completions'
  ]);
});

test('a 20 second stall is abandoned and the next provider answers', async () => {
  resetProviderHealth();
  const result = await routeChat({
    env: { HF_TOKEN: 'hf-test-token', OPENROUTER_API_KEY: 'or-test-key' },
    user: { id: 'user-1' },
    timeoutMs: 30,
    message: 'Hello',
    model: 'nvidia/nemotron-3.5-lightning:free',
    fallbackModel: 'google/gemma-4-31b-it:free',
    system: 'You do not give financial advice. If you do not know, say so.',
    maxTokens: 600,
    fetchImpl: (url, init) => {
      if (String(url).includes('huggingface')) {
        return new Promise(function (resolve, reject) {
          const timer = setTimeout(function () { resolve(chat(200, 'late')); }, 1000);
          if (init && init.signal) init.signal.addEventListener('abort', function () {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return Promise.resolve(chat(200, 'From OpenRouter.'));
    }
  });
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.reply, 'From OpenRouter.');
});

test('an unset GPU node and a zero spend cap are skipped', async () => {
  resetAiLimits();
  resetGpuSpend();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: JSON.stringify({ message: 'Hello' })
  }, {
    OPENROUTER_API_KEY: 'or-test-key',
    GPU_NODE_URL: 'https://gpu.invalid',
    GPU_NODE_KEY: 'gpu-test-key'
  }, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return user();
    return chat(200, 'From OpenRouter.');
  }, 22_000);
  assert.equal(result.body.provider, 'openrouter');
  assert.equal(calls.some(url => url.includes('gpu.invalid')), false);
});

test('signed-in health lists each provider without key values', async () => {
  resetAiLimits();
  resetProviderHealth();
  const result = await handleAi({
    method: 'GET',
    url: '/api/ai?view=health',
    headers: { authorization: 'Bearer good' }
  }, {
    HF_TOKEN: 'hf-test-token',
    OPENROUTER_API_KEY: 'or-test-key',
    GPU_NODE_URL: 'https://gpu.invalid',
    GPU_NODE_KEY: 'gpu-test-key',
    GPU_MONTHLY_CAP_USD: '0'
  }, async (url) => {
    if (String(url).includes('/auth/v1/user')) return user();
    if (String(url).includes('huggingface')) return chat(402, '');
    if (String(url).includes('openrouter')) return chat(200, 'ok');
    return chat(500, '');
  }, 23_000);
  assert.equal(result.status, 200);
  const states = Object.fromEntries(result.body.providers.map(row => [row.id, row]));
  assert.equal(states.byok.state, 'not configured');
  assert.equal(states.huggingface.state, 'no credit');
  assert.equal(states.openrouter.state, 'up');
  assert.equal(typeof states.openrouter.ms, 'number');
  assert.equal(states.overseer.state, 'not configured');
  assert.equal(states.gpu.state, 'not configured');
  const packed = JSON.stringify(result.body);
  assert.equal(packed.includes('hf-test-token'), false);
  assert.equal(packed.includes('or-test-key'), false);
  assert.equal(packed.includes('gpu-test-key'), false);
  const anon = await handleAi({ method: 'GET', url: '/api/ai/health', headers: {} }, { OPENROUTER_API_KEY: 'or-test-key' }, async () => user(), 24_000);
  assert.equal(anon.status, 401);
});

test('the desk names the provider and the GPU files stay templates', () => {
  const client = fs.readFileSync(path.join(root, 'website/os/ai.js'), 'utf8');
  const modal = fs.readFileSync(path.join(root, 'deploy/gpu/modal.py'), 'utf8');
  const runpod = fs.readFileSync(path.join(root, 'deploy/gpu/runpod.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'deploy/gpu/README.md'), 'utf8');
  assert.match(client, /Reply received from /);
  assert.match(client, /openrouter/);
  assert.doesNotMatch(client, /HF_TOKEN|GPU_NODE_KEY|AI_BYOK_ENC_KEY|OPENROUTER_API_KEY/);
  assert.match(modal, /TENSOR_PARALLEL_SIZE/);
  assert.match(runpod, /TENSOR_PARALLEL_SIZE/);
  assert.match(readme, /scale to zero/i);
  assert.match(readme, /GPU_MONTHLY_CAP_USD/);
});
