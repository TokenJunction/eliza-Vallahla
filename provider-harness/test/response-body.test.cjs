'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PROVIDER_RESPONSE_BYTES,
  readBoundedText,
} = require('../lib/response-body');

test('bounded reads accept content at the byte limit', async () => {
  const response = new Response('é', {
    headers: { 'content-length': '2' },
  });
  assert.equal(await readBoundedText(response, 2), 'é');
});

test('bounded reads reject oversized declared and streamed bodies', async () => {
  let pulled = false;
  const declared = {
    headers: new Headers({ 'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) }),
    body: new ReadableStream({
      pull() {
        pulled = true;
      },
    }),
  };
  await assert.rejects(readBoundedText(declared), { code: 'response_too_large' });
  assert.equal(pulled, false);

  let cancelled = false;
  const streamed = {
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  };
  await assert.rejects(readBoundedText(streamed), { code: 'response_too_large' });
  assert.equal(cancelled, true);
});
