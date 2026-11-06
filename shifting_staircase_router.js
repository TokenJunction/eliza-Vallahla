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
