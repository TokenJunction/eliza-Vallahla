'use strict';

// One generation channel. Auth and tenant identity stay in backend/sessions.js.
// Cloud runtime does not dial the PC loopback. Loopback Ollama runs only when
// this process is the customer local relay (VALHALLA_LOCAL_RELAY=1).
// Harness tests use a mocked fetch. They are not a live provider certification.

const { executeCapability } = require('./lib/execute');

function mapTask(body = {}) {
  if (body.capability === 'chat') return { role: 'odin', capability: 'chat' };
  if (body.capability === 'code') return { role: 'odin', capability: 'code' };
  if (body.capability === 'view') return { role: 'thalos', capability: 'view' };
  if (body.capability === 'paper' || body.role === 'thalos') return { role: 'thalos', capability: 'paper' };
  if (body.capability === 'voice' || body.role === 'voice') return { role: 'odin', capability: 'voice' };
  if (body.capability === 'reasoning') return { role: 'odin', capability: 'reasoning' };
  return { role: null, capability: null };
}

async function generateForRequest(body, env, deps = {}) {
  if (deps.signal && deps.signal.aborted) return { completed: false, text: null, reason: 'cancelled' };
  const allowed = Array.isArray(deps.allowedModels) ? deps.allowedModels : [];
  const chosen = body.model && allowed.includes(body.model) ? body.model : '';
  const local = String(env.VALHALLA_LOCAL_RELAY) === '1';
  const mapped = mapTask(body);
  if (!mapped.capability) return { completed: false, text: null, reason: 'capability_rejected' };
  const result = await executeCapability({
    signal: deps.signal,
    model: chosen,
    role: mapped.role,
    capability: mapped.capability,
    prompt: body.text || body.prompt || '',
    runtime: local ? 'local-pc' : 'cloud',
    localPcAwake: local,
    env,
  }, { fetchImpl: deps.fetchImpl, env });
  const text = typeof result.content === 'string' ? result.content.trim() : '';
  const completed = result.available === true && text.length > 0;
  return {
    completed,
    text: completed ? text : null,
    reason: completed ? null : (result.reason || 'unavailable'),
    provider: completed ? result.route : null,
    model: completed ? (result.model || null) : null,
    calls: Array.isArray(result.calls) ? result.calls.length : 0,
    simulated: false,
    audioGenerated: false,
    liveProvider: false,
  };
}

module.exports = { generateForRequest, mapTask };
