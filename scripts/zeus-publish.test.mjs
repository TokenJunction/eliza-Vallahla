import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signRelease, verifyRelease } from './hive-updater.mjs';
import { publishRelease } from './zeus-publish.mjs';

const keys = generateKeyPairSync('ed25519');

test('Zeus signs a completed release and posts it to Wren', async () => {
  let request = null;
  const fakeFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ ok: true, channel: 'akershus', version: '1.0.1', issuedAt: 1, nodes: 2 })
    };
  };

  const result = await publishRelease({
    relayUrl: 'http://wren.test/',
    privateKey: keys.privateKey,
    token: 'publisher-token',
    release: {
      channel: 'akershus',
      path: 'akershus/system',
      version: '1.0.1',
      category: 'system',
      files: [{ name: 'app.txt', text: 'version two' }],
      issuedAt: 1
    },
    fetchImpl: fakeFetch
  });

  assert.equal(request.url, 'http://wren.test/publish');
  assert.equal(request.options.headers.authorization, 'Bearer publisher-token');
  assert.equal(verifyRelease(request.body, keys.publicKey), true);
  assert.equal(result.response.nodes, 2);
});
