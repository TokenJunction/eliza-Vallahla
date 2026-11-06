import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { generateRelayKey } from "../backend/relayGrant.js";
import { attachRelay } from "../backend/wsRelayServer.js";
import {
  createLocalStatusApi,
  createOllamaTunnelClient,
  executeFrame,
  NGROK_CONNECTOR,
  resolveCloudPolicy,
  resolveTestTransport,
  validateTunnelUrl,
} from "./ollamaTunnelClient.js";
import { createBoundedQueue } from "./tunnelEndpoint.js";
import { DEFAULT_MODEL, OLLAMA_GENERATE_URL } from "./ollamaGenerate.js";

process.env.NODE_ENV = "test";

function record(model, extra = {}) {
  return {
    model,
    created_at: "2026-11-06T00:00:00.000Z",
    response: "pong",
    done: true,
    ...extra,
  };
}

function jsonResponse(body, status = 200, type = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { "content-type": type } });
}

function frame(overrides = {}) {
  return {
    taskId: "task-0001",
    prompt: "say pong",
    allowModels: [DEFAULT_MODEL],
    grantExp: Date.now() + 180000,
    timeoutMs: 60000,
    stream: false,
    ...overrides,
  };
}

test("the production tunnel accepts only the configured wss host", () => {
  const https = validateTunnelUrl("https://eliza-valhalla.onrender.com");
  assert.equal(https.ok, true);
  assert.equal(https.url, "wss://eliza-valhalla.onrender.com");
  assert.equal(validateTunnelUrl("wss://eliza-valhalla.onrender.com/ollama").ok, false);
  assert.equal(validateTunnelUrl("https://example.invalid").reason, "host-rejected");
  assert.equal(validateTunnelUrl("http://127.0.0.1:11434/api/generate").reason, "url-rejected");
  assert.equal(validateTunnelUrl("http://eliza-valhalla.onrender.com").reason, "wss-required");
  assert.equal(validateTunnelUrl("wss://eliza-valhalla.onrender.com/?token=abc").ok, false);
  const loop = resolveTestTransport("http://127.0.0.1:4312", { NODE_ENV: "test" });
  assert.equal(loop.ok, true);
  assert.equal(loop.authBypass, false);
  assert.equal(resolveTestTransport("http://127.0.0.1:4312", { NODE_ENV: "production" }).reason, "test-transport-rejected");
  assert.equal(resolveTestTransport("http://127.0.0.2:4312", { NODE_ENV: "test" }).ok, false);
  assert.equal(resolveTestTransport("http://10.1.2.3:4312", { NODE_ENV: "test" }).ok, false);
  assert.equal(resolveTestTransport("http://127.0.0.1:11434", { NODE_ENV: "test" }).reason, "ollama-port-refused");
});

test("generate rejects unknown models, shell tools, and oversized prompts", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(record(DEFAULT_MODEL));
  };
  const unknown = await executeFrame(frame({ model: "not-in-list" }), undefined, () => {}, { fetchImpl });
  assert.equal(unknown.reason, "model-rejected");
  const tool = await executeFrame(frame({ tool: "exec" }), undefined, () => {}, { fetchImpl });
  assert.equal(tool.reason, "unknown-frame");
  const headers = await executeFrame(frame({ headers: { "x-injected": "1" } }), undefined, () => {}, { fetchImpl });
  assert.equal(headers.reason, "unknown-frame");
  const long = await executeFrame(frame({ prompt: "a".repeat(13000) }), undefined, () => {}, { fetchImpl });
  assert.equal(long.reason, "prompt-too-large");
  const wide = await executeFrame(frame({ prompt: "\u00e9".repeat(7000) }), undefined, () => {}, { fetchImpl });
  assert.equal(wide.reason, "prompt-too-large");
  const slow = await executeFrame(frame({ timeoutMs: 300001 }), undefined, () => {}, { fetchImpl });
  assert.equal(slow.reason, "timeout-rejected");
  const short = await executeFrame(frame({ timeoutMs: 1000 }), undefined, () => {}, { fetchImpl });
  assert.equal(short.reason, "timeout-rejected");
  assert.equal(calls, 0);
});

test("generate reads a bounded Ollama body and refuses bad HTTP", async () => {
  const seen = [];
  const ok = await executeFrame(frame(), undefined, (chunk) => seen.push(chunk), {
    fetchImpl: async (url, init) => {
      assert.equal(url, OLLAMA_GENERATE_URL);
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, {
        "content-type": "application/json",
        accept: "application/json, application/x-ndjson",
      });
      const body = JSON.parse(init.body);
      assert.equal(body.model, DEFAULT_MODEL);
      assert.equal(body.stream, false);
      assert.equal(Object.hasOwn(init.headers, "x-injected"), false);
      return jsonResponse(record(body.model));
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, ["pong"]);
  const missing = await executeFrame(frame({ model: undefined, allowModels: ["other-model"] }), undefined, () => {}, {
    fetchImpl: async () => jsonResponse(record("other-model")),
  });
  assert.equal(missing.reason, "model-rejected");
  const status = await executeFrame(frame(), undefined, () => {}, {
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.equal(status.ok, false);
  assert.equal(status.reason, "invalid-http");
  const mismatch = await executeFrame(frame(), undefined, () => {}, {
    fetchImpl: async () => jsonResponse(record("other-model")),
  });
  assert.equal(mismatch.reason, "model-mismatch");
  const toolCall = await executeFrame(frame(), undefined, () => {}, {
    fetchImpl: async () => jsonResponse(record(DEFAULT_MODEL, { tool_calls: [{ name: "exec" }] })),
  });
  assert.equal(toolCall.inert, true);
  assert.equal(toolCall.executed, false);
  assert.equal(JSON.stringify(toolCall).includes("tool_calls"), false);
  const stream = await executeFrame(frame({ stream: true }), undefined, () => {}, {
    fetchImpl: async () => jsonResponse([
      JSON.stringify({ model: DEFAULT_MODEL, created_at: "2026-11-06T00:00:00.000Z", response: "aa", done: false }),
      JSON.stringify({ model: DEFAULT_MODEL, created_at: "2026-11-06T00:00:01.000Z", response: "bb", done: true }),
    ].join("\n"), 200, "application/x-ndjson"),
  });
  assert.equal(stream.ok, true);
  assert.equal(stream.content, "aabb");
  const offline = await executeFrame(frame(), undefined, () => {}, {});
  assert.equal(offline.available, false);
  assert.equal(offline.reason, "ollama-unavailable");
  const redirected = await executeFrame(frame(), undefined, () => {}, {
    fetchImpl: async () => {
      throw new Error("redirect mode is set to error");
    },
  });
  assert.equal(redirected.reason, "redirect-rejected");
});

test("abort and grant expiry stop a hanging generate", async () => {
  const controller = new AbortController();
  const pending = executeFrame(frame(), controller.signal, () => {}, {
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.reason, "aborted");
  const expired = await executeFrame(frame({ grantExp: Date.now() + 40, timeoutMs: 60000 }), undefined, () => {}, {
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  assert.equal(expired.reason, "aborted");
});

test("offline cloud fallback is only the authorized policy answer", async () => {
  const open = await resolveCloudPolicy(async () => ({ runCloud: true }), "offline");
  assert.equal(open.runCloud, false);
  const allowed = await resolveCloudPolicy(async () => ({ authorized: true, runCloud: true }), "offline");
  assert.equal(allowed.runCloud, true);
  const queue = createBoundedQueue(2);
  assert.equal(queue.push("a").ok, true);
  assert.equal(queue.push("b").ok, true);
  assert.equal(queue.push("c").reason, "queue-full");
  const client = createOllamaTunnelClient({
    testTransport: true,
    url: "http://127.0.0.1:1",
    env: { NODE_ENV: "test" },
    grant: "g".repeat(24),
    maxAttempts: 0,
    cloudPolicy: async () => ({ authorized: true, runCloud: true }),
  });
  const state = await client.connect();
  assert.equal(state.available, false);
  assert.equal(state.runCloud, true);
  assert.equal(state.reason, "offline");
  const blocked = createOllamaTunnelClient({
    testTransport: true,
    url: "http://10.0.0.8:9",
    env: { NODE_ENV: "test" },
    grant: "g".repeat(24),
  });
  const rejected = await blocked.connect();
  assert.equal(rejected.reason, "test-transport-rejected");
  client.markAsleep();
  assert.equal(client.state().reason, "device-asleep");
  assert.equal(client.state().available, false);
  await client.close();
  await blocked.close();
});

test("the local status API does not expose the Ollama port", async () => {
  assert.equal(NGROK_CONNECTOR.installed, false);
  assert.equal(NGROK_CONNECTOR.exposesOllama, false);
  assert.equal(NGROK_CONNECTOR.uptimePromise, false);
  const missing = createLocalStatusApi({});
  assert.equal(missing.available, false);
  const token = randomBytes(16).toString("hex");
  const api = createLocalStatusApi({
    token,
    getState: () => ({ available: false, reason: "device-asleep" }),
  });
  const refused = await api.listen(11434);
  assert.equal(refused.reason, "ollama-port-refused");
  const started = await api.listen(0);
  assert.equal(started.ok, true);
  assert.notEqual(started.port, 11434);
  try {
    const anonymous = await fetch(`http://127.0.0.1:${started.port}/status`);
    assert.equal(anonymous.status, 401);
    const events = await fetch(`http://127.0.0.1:${started.port}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /text\/event-stream/);
    const text = await events.text();
    assert.match(text, /device-asleep/);
    assert.equal(text.includes("15"), false);
    const other = await fetch(`http://127.0.0.1:${started.port}/api/generate`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(other.status, 404);
  } finally {
    await started.close();
  }
});

test("a loopback relay round trip uses the fixed generate endpoint", async () => {
  const key = await generateRelayKey("round-trip");
  const httpServer = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const relay = attachRelay(httpServer, {
    key,
    env: { NODE_ENV: "test" },
    allowTestLoopback: true,
    registerTask: async (input) => ({ ok: true, taskId: input.taskId, tenantId: input.tenantId }),
  });
  const port = httpServer.address().port;
  const issued = await relay.issue({
    tenantId: "tenant-a",
    deviceId: "device-a",
    models: [DEFAULT_MODEL],
  }, {
    lookupAccount: async ({ tenantId, deviceId }) => ({ ok: true, role: "owner", tenantId, deviceId }),
    verifyOwner: async () => ({ ok: true }),
  });
  const client = createOllamaTunnelClient({
    testTransport: true,
    url: `http://127.0.0.1:${port}`,
    env: { NODE_ENV: "test" },
    grant: issued.token,
    maxAttempts: 0,
    fetchImpl: async (url, init) => {
      assert.equal(url, OLLAMA_GENERATE_URL);
      const body = JSON.parse(init.body);
      return jsonResponse(record(body.model, { response: "round" }));
    },
  });
  try {
    const connected = await client.connect();
    assert.equal(connected.state, "authenticated");
    const chunks = [];
    const result = await relay.dispatchTask({
      taskId: "task-0099",
      tenantId: "tenant-a",
      deviceId: "device-a",
      prompt: "round",
      model: DEFAULT_MODEL,
      stream: false,
      costReceipt: {
        allocator: "wren",
        allocated: true,
        taskId: "task-0099",
        tenantId: "tenant-a",
        amountUsd: 0,
      },
    }, undefined, (chunk) => chunks.push(chunk));
    assert.equal(result.ok, true);
    assert.deepEqual(chunks, ["round"]);
  } finally {
    await client.close();
    await relay.close();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  }
});
