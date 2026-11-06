'use strict';

// Ordered fallback ladder: each step is tried only when the previous one fails.
const MODEL_LADDER = Object.freeze([
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-r1:free',
]);

function ladderFromEnv(env = process.env) {
  const custom = String(env.VALHALLA_MODEL_LADDER || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return custom.length ? custom : [...MODEL_LADDER];
}

module.exports = { MODEL_LADDER, ladderFromEnv };
