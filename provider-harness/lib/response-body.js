'use strict';

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_LIST_RESPONSE_BYTES = 256 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

function responseTooLarge() {
  const error = new Error('response_too_large');
  error.code = 'response_too_large';
  return error;
}

async function cancelBody(body) {
  if (!body || typeof body.cancel !== 'function') return;
  try {
    await body.cancel();
  } catch {
    // The response may already have completed or been cancelled.
  }
}

async function readBoundedText(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const body = response && response.body;
  const contentLength = response && response.headers
    && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength.trim())) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await cancelBody(body);
      throw responseTooLarge();
    }
  }

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The stream may have cancelled itself.
          }
          throw responseTooLarge();
        }
        chunks.push(decoder.decode(chunk, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock();
    }
  }

  let text = '';
  if (response && typeof response.text === 'function') {
    text = await response.text();
  } else if (response && typeof response.json === 'function') {
    const payload = await response.json();
    text = JSON.stringify(payload) || '';
  }
  if (typeof text !== 'string') text = String(text || '');
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw responseTooLarge();
  return text;
}

module.exports = {
  MAX_HEALTH_RESPONSE_BYTES,
  MAX_MODEL_LIST_RESPONSE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  readBoundedText,
};
