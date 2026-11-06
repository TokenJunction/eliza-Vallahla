'use strict';

const { MODEL_LADDER } = require('./lib/model-ladder');

const FAILURE_LIMIT = 3;
const WINDOW_MS = 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

class CircuitBreaker {
  constructor({ limit = FAILURE_LIMIT, windowMs = WINDOW_MS, cooldownMs = COOLDOWN_MS, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.state = new Map();
  }

  entry(id) {
    if (!this.state.has(id)) this.state.set(id, { failures: [], openUntil: 0 });
    return this.state.get(id);
  }

  isOpen(id) {
    return this.now() < this.entry(id).openUntil;
  }

  recordFailure(id) {
    const entry = this.entry(id);
    const t = this.now();
    entry.failures = entry.failures.filter((ts) => t - ts < this.windowMs);
    entry.failures.push(t);
    if (entry.failures.length >= this.limit) {
      entry.openUntil = t + this.cooldownMs;
      entry.failures = [];
    }
  }

  recordSuccess(id) {
    const entry = this.entry(id);
    entry.failures = [];
    entry.openUntil = 0;
  }
}

const defaultBreaker = new CircuitBreaker();

async function executeShiftingInference(
  prompt,
  systemInstruction,
  apiKey,
  { breaker = defaultBreaker, fetchImpl = globalThis.fetch, models = MODEL_LADDER, timeoutMs = 10000 } = {},
) {
  for (const model of models) {
    if (breaker.isOpen(model)) continue;
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://valhalla-app.xyz',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('empty_response');
      breaker.recordSuccess(model);
      return { content, modelUsed: model };
    } catch {
      breaker.recordFailure(model);
    }
  }
  throw new Error('All fallback models are in cool-down or failing');
}

module.exports = { CircuitBreaker, executeShiftingInference, FAILURE_LIMIT, WINDOW_MS, COOLDOWN_MS };
'use strict';

const DEFAULT_MODELS = Object.freeze([
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
]);
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const COOL_DOWN_MS = 5 * 60_000;

class CircuitBreaker {
  constructor({ now = Date.now, failureWindowMs = FAILURE_WINDOW_MS, threshold = FAILURE_THRESHOLD, coolDownMs = COOL_DOWN_MS } = {}) {
    this.now = now;
    this.failureWindowMs = failureWindowMs;
    this.threshold = threshold;
    this.coolDownMs = coolDownMs;
    this.states = new Map();
  }

  state(model) {
    if (!this.states.has(model)) this.states.set(model, { failures: [], openUntil: 0 });
    return this.states.get(model);
  }

  isOpen(model) {
    const now = this.now();
    const state = this.state(model);
    if (state.openUntil > now) return true;
    if (state.openUntil) state.openUntil = 0;
    return false;
  }

  recordFailure(model) {
    const now = this.now();
    const state = this.state(model);
    state.failures = state.failures.filter((timestamp) => now - timestamp < this.failureWindowMs);
    state.failures.push(now);
    if (state.failures.length >= this.threshold) {
      state.failures = [];
      state.openUntil = now + this.coolDownMs;
      return true;
    }
    return false;
  }

  recordSuccess(model) {
    this.states.set(model, { failures: [], openUntil: 0 });
  }
}

const defaultBreaker = new CircuitBreaker();

async function executeShiftingInference(prompt, systemInstruction, apiKey, options = {}) {
  if (!apiKey) throw new Error('router_not_configured');
  const fetchImpl = options.fetchImpl || fetch;
  const models = options.models || DEFAULT_MODELS;
  const breaker = options.breaker || defaultBreaker;
  const endpoint = options.endpoint || 'https://openrouter.ai/api/v1/chat/completions';

  for (const model of models) {
    if (breaker.isOpen(model)) continue;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.PUBLIC_ORIGIN || 'https://valhalla-app.xyz',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: String(systemInstruction || '').slice(0, 4000) },
            { role: 'user', content: String(prompt || '').slice(0, 12000) },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 10_000),
      });
      if (!response.ok) throw new Error(`provider_http_${response.status}`);
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('provider_empty_response');
      breaker.recordSuccess(model);
      return { content, modelUsed: model };
    } catch (error) {
      const opened = breaker.recordFailure(model);
      console.warn(`[staircase] ${model} failed${opened ? '; circuit open for 5 minutes' : ''}: ${error.message}`);
    }
  }
  throw new Error('all_models_unavailable');
}

module.exports = {
  CircuitBreaker,
  DEFAULT_MODELS,
  FAILURE_WINDOW_MS,
  FAILURE_THRESHOLD,
  COOL_DOWN_MS,
  executeShiftingInference,
};
