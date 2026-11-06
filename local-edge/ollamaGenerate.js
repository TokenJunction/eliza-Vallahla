export const OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate";
export const DEFAULT_MODEL = "qwen2.5-coder:14b";
export const LIMITS = Object.freeze({
  maxPromptBytes: 12 * 1024,
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 512 * 1024,
  defaultTimeoutMs: 120000,
  minTimeoutMs: 60000,
  maxTimeoutMs: 300000,
});

const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FRAME_KEYS = new Set(["taskId", "prompt", "model", "stream", "allowModels", "grantExp", "timeoutMs"]);
const BLOCKED_KEYS = new Set(["tool", "tools", "command", "cmd", "exec", "url", "host", "path", "headers"]);

export function byteLength(value) {
  if (typeof value !== "string") return -1;
  return Buffer.byteLength(value, "utf8");
}

export function generationDeadline({ timeoutMs, grantExp, now = Date.now() } = {}) {
  const requested = timeoutMs == null ? LIMITS.defaultTimeoutMs : timeoutMs;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested > LIMITS.maxTimeoutMs || requested < LIMITS.minTimeoutMs) {
    return { ok: false, reason: "timeout-rejected" };
  }
  if (typeof grantExp !== "number" || !Number.isFinite(grantExp)) return { ok: false, reason: "grant-exp-required" };
  const remaining = grantExp - now;
  if (remaining <= 0) return { ok: false, reason: "grant-expired" };
  return { ok: true, timeoutMs: Math.min(requested, remaining) };
}

function modelChoice(frame) {
  const allow = Array.isArray(frame.allowModels) ? frame.allowModels : null;
  if (!allow) return { ok: false, reason: "model-rejected" };
  const requested = frame.model == null ? DEFAULT_MODEL : frame.model;
  if (typeof requested !== "string" || requested.length > 128 || !MODEL_NAME.test(requested) || requested.includes("/")) {
    return { ok: false, reason: "model-rejected" };
  }
  if (!allow.includes(requested)) return { ok: false, reason: "model-rejected" };
  return { ok: true, model: requested };
}

function emitContent(text, onChunk) {
  if (!text || typeof onChunk !== "function") return;
  const max = 15 * 1024;
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + max);
    while (end > offset && Buffer.byteLength(text.slice(offset, end)) >= 16 * 1024) end -= 128;
    if (end <= offset) end = Math.min(text.length, offset + 1);
    onChunk(text.slice(offset, end));
    offset = end;
  }
}

function timestampOk(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function parseGenerate(buffer, model, stream) {
  const text = buffer.toString("utf8");
  if (!stream) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid-http" };
    }
    return oneRecord(body, model, true);
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length < 1) return { ok: false, reason: "invalid-http" };
  let content = "";
  for (let index = 0; index < lines.length; index += 1) {
    let body;
    try {
      body = JSON.parse(lines[index]);
    } catch {
      return { ok: false, reason: "invalid-http" };
    }
    const final = index === lines.length - 1;
    const record = oneRecord(body, model, final);
    if (!record.ok) return record;
    if (record.inert) return record;
    content += record.content;
    if (!final && body.done === true) return { ok: false, reason: "invalid-http" };
  }
  return { ok: true, content, model };
}

function oneRecord(body, model, final) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "invalid-http" };
  if (body.tool_calls || body.toolCalls) return { ok: false, reason: "tool-call-inert", inert: true, executed: false };
  if (body.model !== model) return { ok: false, reason: "model-mismatch" };
  if (!timestampOk(body.created_at)) return { ok: false, reason: "timestamp-required" };
  if (final && body.done !== true) return { ok: false, reason: "invalid-http" };
  if (typeof body.response !== "string") return { ok: false, reason: "invalid-http" };
  return { ok: true, content: body.response, model };
}

export async function executeFrame(frame, signal, onChunk, deps = {}) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return { ok: false, reason: "unknown-frame" };
  const keys = Object.keys(frame);
  if (keys.some((key) => BLOCKED_KEYS.has(key) || !FRAME_KEYS.has(key))) return { ok: false, reason: "unknown-frame" };
  if (typeof frame.prompt !== "string" || byteLength(frame.prompt) < 1) return { ok: false, reason: "prompt-required" };
  if (byteLength(frame.prompt) > LIMITS.maxPromptBytes) return { ok: false, reason: "prompt-too-large" };
  const selected = modelChoice(frame);
  if (!selected.ok) return selected;
  const stream = frame.stream === true;
  if (frame.stream != null && frame.stream !== true && frame.stream !== false) return { ok: false, reason: "unknown-frame" };
  const deadline = generationDeadline({ timeoutMs: frame.timeoutMs, grantExp: frame.grantExp });
  if (!deadline.ok) return deadline;
  const payload = { model: selected.model, prompt: frame.prompt, stream };
  const body = JSON.stringify(payload);
  if (byteLength(body) > LIMITS.maxRequestBytes) return { ok: false, reason: "request-too-large" };
  if (typeof deps.fetchImpl !== "function") return { ok: false, available: false, reason: "ollama-unavailable" };
  const controller = new AbortController();
  const started = process.hrtime.bigint();
  const timer = setTimeout(() => controller.abort(), deadline.timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await deps.fetchImpl(OLLAMA_GENERATE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, application/x-ndjson",
      },
      body,
      signal: controller.signal,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs > deadline.timeoutMs || Date.now() >= frame.grantExp) {
      return { ok: false, reason: "timeout" };
    }
    if (!response || response.status !== 200) return { ok: false, reason: "invalid-http" };
    const type = String(response.headers && response.headers.get ? response.headers.get("content-type") : "");
    if (!type.includes("json")) return { ok: false, reason: "invalid-http" };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > LIMITS.maxResponseBytes) return { ok: false, reason: "response-too-large" };
    const parsed = parseGenerate(buffer, selected.model, stream);
    if (!parsed.ok) return parsed;
    emitContent(parsed.content, onChunk);
    return { ok: true, content: parsed.content, model: selected.model, executed: false };
  } catch (error) {
    if (controller.signal.aborted || (signal && signal.aborted) || (error && error.name === "AbortError")) {
      return { ok: false, reason: "aborted" };
    }
    if (error && /redirect/i.test(String(error.message))) return { ok: false, reason: "redirect-rejected" };
    return { ok: false, available: false, reason: "ollama-unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
