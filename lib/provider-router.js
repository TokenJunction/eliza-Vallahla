'use strict';

// Odin routes voice and reasoning. Thalos is paper and view only.
// Ollama is used only for an awake local PC on a loopback address.
// A missing provider, capability, or budget is unavailable. This module does
// not invent a reply or a healthy status, and it does not log secrets.

const CALL_USD = 0.01;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const CLOUD = Object.freeze({
  gemini: Object.freeze({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyNames: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']),
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  }),
  deepseek: Object.freeze({
    provider: 'deepseek',
    model: 'deepseek-chat',
    keyNames: Object.freeze(['DEEPSEEK_API_KEY']),
    url: 'https://api.deepseek.com/chat/completions',
  }),
});

const ROLES = Object.freeze({
  odin: Object.freeze({
    voice: Object.freeze({ cloud: 'gemini', localModel: 'llama3.2' }),
    reasoning: Object.freeze({ cloud: 'deepseek', localModel: 'llama3.2' }),
  }),
  thalos: Object.freeze({
    paper: Object.freeze({ cloud: 'deepseek', localModel: 'llama3.2' }),
    view: Object.freeze({ cloud: 'deepseek', localModel: 'llama3.2' }),
  }),
});

function unavailable(role, capability, reason, extra = {}) {
  return {
    available: false,
    status: 'unavailable',
    providerState: 'unavailable',
    role: role || null,
    capability: capability || null,
    reason,
    route: null,
    content: null,
    chargedUsd: 0,
    liveExecution: false,
    ...extra,
  };
}

function budgetDecision(budget) {
  if (!budget || typeof budget !== 'object') return { ok: false };
  const remaining = budget.remainingUsd;
  const call = budget.callUsd === undefined ? CALL_USD : budget.callUsd;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return { ok: false };
  if (typeof call !== 'number' || !Number.isFinite(call) || call <= 0) return { ok: false };
  if (remaining < call) return { ok: false };
  return { ok: true, callUsd: call };
}

function loopbackOrigin(base) {
  let url;
  try {
    url = new URL(base || 'http://127.0.0.1:11434');
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function localOllama(input) {
  if (!input || input.runtime !== 'local-pc') return { ok: false, reason: 'runtime_not_local' };
  if (input.localPcAwake !== true) return { ok: false, reason: 'local_pc_asleep' };
  const origin = loopbackOrigin(input.ollamaBaseUrl);
  if (!origin) return { ok: false, reason: 'ollama_not_loopback' };
  return { ok: true, origin };
}

function cloudSecret(name, secrets) {
  const spec = CLOUD[name];
  if (!spec || !secrets || typeof secrets !== 'object') return null;
  for (const keyName of spec.keyNames) {
    const value = secrets[keyName];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function roleSpec(role, capability) {
  const table = ROLES[role];
  if (!table || !Object.hasOwn(table, capability)) return null;
  return table[capability];
}

function selectRoute(input = {}) {
  const role = input.role;
  const capability = input.capability;
  const spec = roleSpec(role, capability);
  if (!spec) return unavailable(role, capability, 'capability_unavailable');
  const budget = budgetDecision(input.budget);
  if (!budget.ok) return unavailable(role, capability, 'budget_exhausted');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return unavailable(role, capability, 'prompt_missing');
  }

  const local = localOllama(input);
  const cloudName = spec.cloud;
  const hasCloud = Boolean(cloudSecret(cloudName, input.secrets));
  const mode = role === 'thalos' ? 'paper' : 'advisory';
  if (local.ok) {
    return {
      available: true,
      status: 'routed',
      providerState: 'not_probed',
      role,
      capability,
      route: 'ollama',
      model: spec.localModel,
      origin: local.origin,
      fallback: hasCloud ? cloudName : null,
      callUsd: budget.callUsd,
      mode,
      liveExecution: false,
      content: null,
      chargedUsd: 0,
    };
  }
  if (!hasCloud) return unavailable(role, capability, 'provider_missing', { detail: local.reason });
  return {
    available: true,
    status: 'routed',
    providerState: 'not_probed',
    role,
    capability,
    route: cloudName,
    model: CLOUD[cloudName].model,
    fallbackFrom: local.reason,
    callUsd: budget.callUsd,
    mode,
    liveExecution: false,
    content: null,
    chargedUsd: 0,
  };
}

function textFrom(payload, route) {
  if (!payload || typeof payload !== 'object') return '';
  if (route === 'ollama') {
    const chat = payload.message && payload.message.content;
    const generated = payload.response;
    return typeof chat === 'string' ? chat : typeof generated === 'string' ? generated : '';
  }
  if (route === 'gemini') {
    const parts = payload.candidates && payload.candidates[0] && payload.candidates[0].content
      && payload.candidates[0].content.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  const content = payload.choices && payload.choices[0] && payload.choices[0].message
    && payload.choices[0].message.content;
  return typeof content === 'string' ? content : '';
}

function systemFor(role, capability) {
  if (role === 'thalos') {
    return 'You are Thalos. Paper and view only. Do not place orders, move funds, or invent a fill. If data is missing, say unavailable.';
  }
  if (capability === 'voice') {
    return 'You are Odin voice. Speak only from supplied text. If you cannot, say the capability is unavailable.';
  }
  return 'You are Odin. Reason from supplied text. Do not invent market data or a healthy status.';
}

async function callProvider(route, input, fetchImpl, origin) {
  const prompt = input.prompt.trim();
  const system = systemFor(input.role, input.capability);
  const model = route.model;
  let url;
  const headers = { 'content-type': 'application/json' };
  let body;
  if (route.route === 'ollama') {
    url = `${origin}/api/chat`;
    body = {
      model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
  } else if (route.route === 'gemini') {
    const key = cloudSecret('gemini', input.secrets);
    url = CLOUD.gemini.url;
    if (!key || url.includes(key)) return { ok: false };
    headers['x-goog-api-key'] = key;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    };
  } else if (route.route === 'deepseek') {
    const key = cloudSecret('deepseek', input.secrets);
    url = CLOUD.deepseek.url;
    if (!key || url.includes(key)) return { ok: false };
    headers.authorization = `Bearer ${key}`;
    body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
  } else {
    return { ok: false };
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response || !response.ok) return { ok: false };
  const payload = await response.json().catch(() => null);
  const content = textFrom(payload, route.route).trim();
  if (!content) return { ok: false };
  return { ok: true, content };
}

function answered(route, content, callUsd, providerState) {
  return {
    available: true,
    status: 'routed',
    providerState,
    role: route.role,
    capability: route.capability,
    reason: null,
    route: route.route,
    model: route.model,
    mode: route.mode,
    fallbackFrom: route.fallbackFrom || null,
    liveExecution: false,
    content,
    chargedUsd: callUsd,
  };
}

async function executeRoute(input = {}, deps = {}) {
  const selected = selectRoute(input);
  if (!selected.available) return selected;
  if (typeof deps.fetchImpl !== 'function') {
    return unavailable(input.role, input.capability, 'provider_unavailable');
  }
  try {
    if (selected.route === 'ollama') {
      const local = await callProvider(selected, input, deps.fetchImpl, selected.origin);
      if (local.ok) return answered(selected, local.content, selected.callUsd, 'responded');
      if (!selected.fallback) return unavailable(input.role, input.capability, 'provider_unavailable');
      const cloud = {
        ...selected,
        route: selected.fallback,
        model: CLOUD[selected.fallback].model,
        fallbackFrom: 'ollama_unavailable',
      };
      const fallback = await callProvider(cloud, input, deps.fetchImpl, null);
      if (!fallback.ok) return unavailable(input.role, input.capability, 'provider_unavailable');
      return answered(cloud, fallback.content, selected.callUsd, 'responded');
    }
    const cloud = await callProvider(selected, input, deps.fetchImpl, null);
    if (!cloud.ok) return unavailable(input.role, input.capability, 'provider_unavailable');
    return answered(selected, cloud.content, selected.callUsd, 'responded');
  } catch {
    return unavailable(input.role, input.capability, 'provider_unavailable');
  }
}

module.exports = {
  CALL_USD,
  CLOUD,
  budgetDecision,
  executeRoute,
  loopbackOrigin,
  selectRoute,
};
