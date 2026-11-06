'use strict';

// Device-side local model client. The backend never dials this address.
// Generate and chat are separate calls with fixed loopback URLs.
// Offline tests inject fetch. This file does not prove a local Ollama install.
//
// External HTTP and Jupiter calls are capped at 5 seconds by the relay.
// Local generation is a different deadline. A local model can be slower
// than 5 seconds. The default local limit here is 30 seconds.

const LOCAL_ORIGIN = 'http://127.0.0.1:11434';
const GENERATE_PATH = '/api/generate';
const CHAT_PATH = '/api/chat';
const TAGS_PATH = '/api/tags';
const GENERATE_URL = LOCAL_ORIGIN + GENERATE_PATH;
const CHAT_URL = LOCAL_ORIGIN + CHAT_PATH;
const TAGS_URL = LOCAL_ORIGIN + TAGS_PATH;
const DEFAULT_LOCAL_TIMEOUT_MS = 30_000;
const MAX_LOCAL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE = 256 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const FORMAT_MAX_BYTES = 1024;
const NUM_PREDICT_MAX = 4096;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const OPTION_LIMITS = Object.freeze({
  num_predict: Object.freeze({ min: 1, max: NUM_PREDICT_MAX, int: true }),
  temperature: Object.freeze({ min: 0, max: 2, int: false }),
  top_p: Object.freeze({ min: 0, max: 1, int: false }),
  top_k: Object.freeze({ min: 1, max: 200, int: true }),
  seed: Object.freeze({ min: 0, max: 2147483647, int: true }),
  num_ctx: Object.freeze({ min: 1, max: 8192, int: true }),
  repeat_penalty: Object.freeze({ min: 0, max: 2, int: false }),
});

function fail(reason) {
  return { ok: false, reason, executedTools: false, verifiedGeneration: false };
}

function banned(value) {
  if (typeof value !== 'string') return false;
  const text = value.toLowerCase();
  return text.includes('/etc') || text.includes('\\') || text.includes('..') || text.includes('socket') || text.includes('%2f');
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (kind !== 'object') throw new TypeError('unsupported_type');
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  const out = Array.isArray(value)
    ? '[' + value.map((item) => canonicalJson(item, seen)).join(',') + ']'
    : '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key], seen)).join(',') + '}';
  seen.delete(value);
  return out;
}

function normalizeFormat(format) {
  if (format === undefined || format === null) return { ok: true, format: undefined };
  if (typeof format !== 'object' || Array.isArray(format)) return fail('format_not_object');
  let encoded;
  try { encoded = canonicalJson(format); } catch { return fail('format_not_json'); }
  if (Buffer.byteLength(encoded, 'utf8') > FORMAT_MAX_BYTES) return fail('format_too_large');
  return { ok: true, format: JSON.parse(encoded) };
}

function normalizeOptions(options, { requirePredict }) {
  if (options === undefined) return requirePredict ? fail('num_predict_required') : { ok: true, options: {} };
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fail('bad_options');
  if (requirePredict && !Object.prototype.hasOwnProperty.call(options, 'num_predict')) return fail('num_predict_required');
  const out = {};
  for (const key of Object.keys(options)) {
    if (key === 'num_predict' && options[key] === undefined) return fail('num_predict_required');
    if (key === 'max_tokens' || key === 'maxTokens') return fail('unlimited_max_tokens_rejected');
    const rule = OPTION_LIMITS[key];
    if (!rule) return fail('option_not_allowed:' + key);
    const value = options[key];
    if (value === undefined) return fail('option_undefined:' + key);
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail('bad_option_value:' + key);
    if (rule.int && !Number.isSafeInteger(value)) return fail('option_not_integer:' + key);
    if (value < rule.min || value > rule.max) return fail('option_out_of_bounds:' + key);
    out[key] = value;
  }
  return { ok: true, options: out };
}

function assertModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model) || banned(model)) return fail('bad_model');
  return { ok: true, model };
}

function assertTimeout(timeoutMs, localTimeoutMs) {
  const ceiling = localTimeoutMs === undefined ? DEFAULT_LOCAL_TIMEOUT_MS : localTimeoutMs;
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > MAX_LOCAL_TIMEOUT_MS) return fail('bad_local_timeout');
  const chosen = timeoutMs === undefined ? ceiling : timeoutMs;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > MAX_LOCAL_TIMEOUT_MS) return fail('bad_timeout');
  if (chosen > ceiling) return fail('timeout_exceeds_local_config');
  return { ok: true, timeoutMs: chosen, localTimeoutMs: ceiling };
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error('response_too_large');
    throw error;
  }
  if (!res.body || typeof res.body.getReader !== 'function') throw new Error('response_not_streamable');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    const size = value ? value.byteLength : 0;
    total += size;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already failed closed */ }
      throw new Error('response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function boundedFetch(fetchImpl, url, init, { signal, timeoutMs, maxBytes }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_required');
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) throw new Error('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetchImpl(url, Object.assign({}, init, { redirect: 'manual', signal: ctl.signal, credentials: 'omit' }));
    if (res.status >= 300 && res.status < 400) throw new Error('redirect_refused');
    if (!res.ok) throw new Error('http_' + res.status);
    return await readCapped(res, maxBytes);
  } catch (error) {
    if (signal && signal.aborted) throw new Error('cancelled');
    if (ctl.signal.aborted) throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function inert(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return { inert: true }; }
}

function parseGenerateBody(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return fail('empty_response');
  let response = '';
  let sawResponse = false;
  let done = false;
  let modelName = null;
  const toolCalls = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { return fail('malformed_json'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('malformed_frame');
    if (row.error) return fail('ollama_error');
    if (done) return fail('data_after_done');
    if (Array.isArray(row.models) && row.response === undefined && row.done !== true) return fail('listing_not_generation');
    if (row.response !== undefined && typeof row.response !== 'string') return fail('response_type');
    if (typeof row.response === 'string') {
      response += row.response;
      sawResponse = true;
    }
    if (Array.isArray(row.tool_calls)) for (const call of row.tool_calls) toolCalls.push(inert(call));
    if (typeof row.model === 'string') modelName = row.model;
    if (row.done === true) done = true;
  }
  if (!done) return fail('stream_incomplete');
  if (!sawResponse) return fail('response_required');
  if (response.trim().length === 0) return fail('empty_generation');
  return { ok: true, response, content: response, toolCalls, model: modelName, executedTools: false, verifiedGeneration: true, roleRequired: false };
}

function parseChatBody(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return fail('empty_response');
  let content = '';
  let done = false;
  let modelName = null;
  const toolCalls = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { return fail('malformed_json'); }
    if (!row || typeof row !== 'object') return fail('malformed_frame');
    if (row.error) return fail('ollama_error');
    if (done) return fail('data_after_done');
    if (row.message !== undefined) {
      if (!row.message || row.message.role !== 'assistant') return fail('unexpected_role');
      if (typeof row.message.content === 'string') content += row.message.content;
      if (Array.isArray(row.message.tool_calls)) for (const call of row.message.tool_calls) toolCalls.push(inert(call));
    }
    if (typeof row.model === 'string') modelName = row.model;
    if (row.done === true) done = true;
  }
  if (!done) return fail('stream_incomplete');
  if (!content.trim() && toolCalls.length === 0) return fail('empty_generation');
  return { ok: true, content, toolCalls, model: modelName, executedTools: false, verifiedGeneration: true };
}

function mapFetchError(error) {
  const message = error && error.message;
  if (message === 'cancelled' || message === 'timeout') return message;
  if (/^(http_\d+|redirect_refused|response_too_large|response_not_streamable)$/.test(message || '')) return message;
  return 'local_unavailable';
}

async function runLocalGenerate(input = {}) {
  if (input.url !== undefined || input.baseUrl !== undefined || input.endpoint !== undefined) return fail('path_override_rejected');
  if (input.path !== undefined && input.path !== GENERATE_PATH) return fail('path_not_allowed');
  if (banned(input.path || '') || banned(input.model || '')) return fail('path_not_allowed');
  if (input.stream !== false) return fail('stream_must_be_false');
  const modelGate = assertModel(input.model);
  if (!modelGate.ok) return modelGate;
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) return fail('bad_prompt');
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_BODY_BYTES) return fail('prompt_too_large');
  const format = normalizeFormat(input.format);
  if (!format.ok) return format;
  const options = normalizeOptions(input.options, { requirePredict: true });
  if (!options.ok) return options;
  const timeout = assertTimeout(input.timeoutMs, input.localTimeoutMs);
  if (!timeout.ok) return timeout;
  const payload = { model: modelGate.model, prompt: input.prompt, stream: false, options: options.options };
  if (format.format) payload.format = format.format;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return fail('body_too_large');
  const full = {
    model: payload.model,
    prompt: payload.prompt,
    stream: false,
    format: payload.format,
    options: payload.options,
    path: GENERATE_PATH,
  };
  if (typeof input.allowlistCheck !== 'function') return fail('allowlist_callback_required');
  let allowed;
  try { allowed = input.allowlistCheck(full); } catch { return fail('allowlist_rejected'); }
  if (!allowed || allowed.ok !== true) return fail('model_not_on_device_allowlist');
  if (allowed.model !== undefined && allowed.model !== full.model) return fail('model_not_on_device_allowlist');
  try {
    const text = await boundedFetch(input.fetchImpl, GENERATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, {
      signal: input.signal,
      timeoutMs: timeout.timeoutMs,
      maxBytes: input.maxResponseBytes || DEFAULT_MAX_RESPONSE,
    });
    return parseGenerateBody(text);
  } catch (error) {
    return fail(mapFetchError(error));
  }
}

// Preserved chat helper. Same export name as the reference client.
// The URL is only POST /api/chat on 127.0.0.1:11434. Tool calls stay inert.
async function runLocalChat({ frame, allowedModels, fetchImpl, signal, timeoutMs, maxResponseBytes, localTimeoutMs } = {}) {
  const req = frame && frame.request;
  if (!req || req.url !== undefined) return fail('path_override_rejected');
  if (req.path !== CHAT_PATH) return fail('path_not_allowed');
  if (banned(req.model || '') || banned(req.path || '')) return fail('path_not_allowed');
  if (!Array.isArray(req.messages) || req.messages.length === 0) return fail('bad_messages');
  const modelGate = assertModel(req.model);
  if (!modelGate.ok) return modelGate;
  if (!Array.isArray(allowedModels) || !allowedModels.includes(req.model)) return fail('model_not_on_device_allowlist');
  const options = normalizeOptions(req.options || {}, { requirePredict: false });
  if (!options.ok) return options;
  const timeout = assertTimeout(timeoutMs, localTimeoutMs);
  if (!timeout.ok) return timeout;
  const payload = {
    model: req.model,
    messages: req.messages,
    options: options.options,
    stream: req.stream !== false,
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return fail('body_too_large');
  try {
    const text = await boundedFetch(fetchImpl, CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, { signal, timeoutMs: timeout.timeoutMs, maxBytes: maxResponseBytes || DEFAULT_MAX_RESPONSE });
    return parseChatBody(text);
  } catch (error) {
    return fail(mapFetchError(error));
  }
}

async function listLocalModels({ fetchImpl, signal, timeoutMs = 5000, localTimeoutMs = 5000 } = {}) {
  const timeout = assertTimeout(timeoutMs, localTimeoutMs);
  if (!timeout.ok) return Object.assign(fail(timeout.reason), { models: [] });
  try {
    const text = await boundedFetch(fetchImpl, TAGS_URL, { method: 'GET' }, {
      signal,
      timeoutMs: timeout.timeoutMs,
      maxBytes: 64 * 1024,
    });
    const row = JSON.parse(text);
    if (!row || !Array.isArray(row.models)) return Object.assign(fail('bad_tags'), { models: [] });
    return {
      ok: true,
      models: row.models.map((item) => item && item.name).filter((name) => typeof name === 'string'),
      verifiedGeneration: false,
      executedTools: false,
    };
  } catch {
    return Object.assign(fail('local_unavailable'), { models: [] });
  }
}

module.exports = {
  LOCAL_ORIGIN,
  GENERATE_URL,
  CHAT_URL,
  TAGS_URL,
  DEFAULT_LOCAL_TIMEOUT_MS,
  MAX_BODY_BYTES,
  FORMAT_MAX_BYTES,
  NUM_PREDICT_MAX,
  runLocalGenerate,
  runLocalChat,
  listLocalModels,
  parseGenerateBody,
  parseChatBody,
  readCapped,
};
