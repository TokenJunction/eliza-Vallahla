'use strict';

// One generation channel. Auth and tenant identity stay in backend/sessions.js.
// Cloud runtime does not dial the PC loopback. Loopback Ollama runs only when
// this process is the customer local relay (VALHALLA_LOCAL_RELAY=1).
// Harness tests use a mocked fetch. They are not a live provider certification.

const { executeCapability } = require('./lib/execute');

function mapTask(body = {}) {
  if (body.role === 'thalos' || body.capability === 'paper' || body.capability === 'view') {
    return { role: 'thalos', capability: body.capability === 'view' ? 'view' : 'paper' };
  }
  if (body.role === 'voice' || body.capability === 'voice') {
    return { role: 'odin', capability: 'voice' };
  }
  return { role: 'odin', capability: 'reasoning' };
}

async function generateForRequest(body, env, deps = {}) {
  const local = String(env.VALHALLA_LOCAL_RELAY) === '1';
  const mapped = mapTask(body);
  const result = await executeCapability({
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

module.exports = { generateForRequest };
