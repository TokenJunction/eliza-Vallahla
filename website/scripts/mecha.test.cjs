const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, routeTask, loadCharacter, handleMechas, customerNode } = require('./mecha-core.cjs');

test('the supervisor routes Mechas and never loads Zeus', () => {
  assert.equal(routeTask('check the deploy health'), 'wren');
  assert.equal(routeTask('draft the release notes'), 'herald');
  assert.equal(loadCharacter('zeus'), null);
  assert.equal(loadCharacter('conductor').name, 'Conductor');
  assert.equal(/zeus/i.test(loadCharacter('sentinel').system), true);
  assert.equal(customerNode({}), true);
  assert.equal(customerNode({ NODE_ROLE: 'coordinator' }), false);
});

test('merge, money, DNS, posting, and trading wait for approval', async () => {
  assert.equal(classify('merge the pull request').kind, 'merge');
  assert.equal(classify('change the dns').kind, 'dns');
  assert.equal(classify('post this').kind, 'post');
  assert.equal(classify('trade the position').kind, 'trade');
  let calledModel = false;
  const result = await handleMechas({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: JSON.stringify({ task: 'merge the pull request' })
  }, { NODE_ROLE: 'customer' }, async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    if (target.includes('openrouter.ai') || target.includes('/v1/chat/completions')) calledModel = true;
    return { ok: true, json: async () => ([]) };
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.pending, true);
  assert.equal(result.body.executed, false);
  assert.equal(result.body.kind, 'merge');
  assert.equal(calledModel, false);
});

test('a customer node refuses Zeus and a busy free model falls through', async () => {
  const refused = await handleMechas({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: JSON.stringify({ task: 'run zeus on this node', node: 'customer' })
  }, {}, async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    return { ok: true, json: async () => ([]) };
  });
  assert.equal(refused.status, 400);
  const models = [];
  const answered = await handleMechas({
    method: 'POST',
    headers: { authorization: 'Bearer person' },
    body: JSON.stringify({ task: 'what is the desktop shell' })
  }, { OPENROUTER_API_KEY: 'test-key', VLLM_BASE_URL: 'https://home.example' }, async (url, init) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1' }) };
    if (target.includes('home.example')) throw new Error('offline');
    if (target.includes('openrouter.ai')) {
      const body = JSON.parse(init.body);
      models.push(body.model);
      if (body.model.indexOf('nemotron') !== -1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'The desk is the controller.' } }] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.brain.endsWith(':free'), true);
  assert.equal(models[0].indexOf('nemotron') !== -1, true);
  assert.equal(models[1].indexOf('gemma') !== -1, true);
  assert.equal(answered.body.executed, false);
});
