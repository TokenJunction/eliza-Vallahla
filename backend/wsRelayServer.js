import { Server } from "socket.io";
import { costReceiptOk, DEFAULT_ISSUER, issueDeviceGrant, verifyDeviceGrant } from "./relayGrant.js";
import {
  LIMITS,
  NAME_ID,
  TASK_ID,
  byteLength,
  createIdempotencyStore,
  createNonceStore,
  createSingleWriter,
  jsonByteLength,
  replyHash,
  validateRelayTransport,
} from "./relayState.js";

export { validateRelayTransport, LIMITS };

export const RELAY_HOOKS = [
  "Do not edit valhallaMasterEngineV35.js or task-invocation.js in this change.",
  "Create the HTTP server in the existing engine.",
  "Call attachRelay(httpServer, { key, renderProxy: true, issuer }).",
  "The Socket.IO path is /relay. Other routes stay on the same listener.",
  "Call issueDeviceGrant only after lookupAccount and verifyOwner.",
  "Send the grant to the device from the server. Do not put it in a query string.",
  "Do not send the task session cookie or the task bearer token to the device.",
  "Register the task id in the Wren task store.",
  "Allocate the task cost in Wren. The receipt uses allocator wren.",
  "Call dispatchTask(frame, signal, onChunk) after that registration and receipt.",
  "The relay does not allocate cost and does not choose the provider.",
  "In-memory idempotency is not the durable task store.",
  "Abort and timeout release the in-flight slot and the pending idempotency row.",
  "A device grant jti stays single use.",
].join("\n");

const DISPATCH_KEYS = new Set([
  "taskId",
  "tenantId",
  "deviceId",
  "prompt",
  "model",
  "stream",
  "timeoutMs",
  "costReceipt",
]);

const REASON = /^[a-z-]{1,40}$/;

export function resolveTaskTimeout(requested, env) {
  const value = requested == null ? LIMITS.taskTimeoutMs : requested;
  if (typeof value !== "number" || !Number.isFinite(value) || value > LIMITS.maxTaskTimeoutMs) {
    return { ok: false, reason: "timeout-rejected" };
  }
  const min = env && env.NODE_ENV === "test" ? 50 : 60000;
  if (value < min) return { ok: false, reason: "timeout-rejected" };
  return { ok: true, timeoutMs: value };
}

function allowedKeys(payload, keys) {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).every((key) => keys.has(key));
}

function safeReason(value, fallback) {
  return typeof value === "string" && REASON.test(value) ? value : fallback;
}

export function attachRelay(httpServer, options = {}) {
  if (!httpServer || typeof httpServer.on !== "function") {
    return { available: false, reason: "http-server required" };
  }
  const maxActive = options.maxActive ?? LIMITS.maxActive;
  const maxQueue = options.maxQueue ?? LIMITS.maxQueue;
  const write = createSingleWriter();
  const nonces = createNonceStore();
  const idempotency = createIdempotencyStore();
  const devices = new Map();
  const trace = { preAuth: [], droppedCrossTenant: 0, credentialQuery: false, order: [] };
  const authTimeoutMs = options.authTimeoutMs ?? LIMITS.authTimeoutMs;
  const issuer = options.issuer || DEFAULT_ISSUER;

  const io = new Server(httpServer, {
    path: "/relay",
    serveClient: false,
    maxHttpBufferSize: LIMITS.maxHttpBufferSize,
    cors: { origin: false },
    allowRequest(req, callback) {
      const decision = validateRelayTransport(req, options);
      if (!decision.ok) {
        if (decision.reason === "query-credentials-rejected") trace.credentialQuery = true;
        callback(decision.reason, false);
        return;
      }
      callback(null, true);
    },
  });

  io.on("connection", (socket) => {
    let session = null;
    let closed = false;
    let authStarted = false;
    const timer = setTimeout(() => {
      if (!session && !closed) {
        closed = true;
        socket.disconnect(true);
      }
    }, authTimeoutMs);

    socket.on("disconnect", () => {
      const current = session;
      closed = true;
      session = null;
      clearTimeout(timer);
      if (!current) return;
      void write(() => {
        if (devices.get(current.deviceId) === current) devices.delete(current.deviceId);
        const queued = current.queue.splice(0);
        for (const job of queued) job.failQueued();
        for (const task of [...current.active.values()]) task.fail("device-disconnected");
        current.active.clear();
      });
    });

    socket.onAny((event, payload) => {
      if (closed) return;
      if (!session) {
        if (authStarted || event !== "auth") {
          trace.preAuth.push(String(event));
          closed = true;
          clearTimeout(timer);
          socket.disconnect(true);
          return;
        }
        authStarted = true;
        void acceptAuth(payload);
        return;
      }
      const current = session;
      void write(() => {
        if (!current || devices.get(current.deviceId) !== current) return;
        const size = jsonByteLength(payload);
        current.bytes += Number.isFinite(size) ? size : LIMITS.maxConnectionBytes;
        if (current.bytes >= LIMITS.maxConnectionBytes) {
          socket.disconnect(true);
          return;
        }
        if (event === "chunk") onChunk(current, payload);
        else if (event === "done") onTerminal(current, payload, "done");
        else if (event === "error" || event === "aborted") onTerminal(current, payload, event);
        else socket.emit("frame-error", { reason: "unknown-frame" });
      });
    });

    async function acceptAuth(payload) {
      const decision = await write(async () => {
        if (closed) return { fail: "closed" };
        const grant = payload && typeof payload === "object" ? payload.grant : "";
        const verified = await verifyDeviceGrant(grant, {
          key: options.key,
          issuer,
          now: typeof options.now === "function" ? options.now() : undefined,
        });
        if (!verified.ok) return { fail: verified.reason };
        const consumed = await nonces.use(verified.jti, verified.exp, Date.now());
        if (!consumed.ok) return { fail: consumed.reason };
        if (devices.has(verified.deviceId)) return { fail: "device-already-connected" };
        const created = {
          socket,
          tenantId: verified.tenantId,
          deviceId: verified.deviceId,
          role: verified.role,
          models: verified.models,
          exp: verified.exp,
          bytes: 0,
          activeCount: 0,
          active: new Map(),
          queue: [],
        };
        devices.set(verified.deviceId, created);
        return { created };
      });
      if (!decision || decision.fail || closed) {
        if (decision && decision.created && devices.get(decision.created.deviceId) === decision.created) {
          devices.delete(decision.created.deviceId);
        }
        socket.emit("auth-no", { reason: decision && decision.fail ? decision.fail : "auth-failed" });
        closed = true;
        clearTimeout(timer);
        socket.disconnect(true);
        return;
      }
      session = decision.created;
      clearTimeout(timer);
      socket.emit("auth-ok", {
        tenantId: session.tenantId,
        deviceId: session.deviceId,
        role: session.role,
        exp: session.exp,
        models: session.models,
      });
    }

    function onChunk(current, payload) {
      if (!allowedKeys(payload, new Set(["taskId", "seq", "data"]))) {
        socket.emit("frame-error", { reason: "unknown-frame" });
        return;
      }
      const task = current.active.get(payload.taskId) || null;
      if (!task) {
        trace.droppedCrossTenant += 1;
        socket.emit("frame-error", { reason: "task-denied" });
        return;
      }
      const size = byteLength(payload.data);
      if (size < 0 || size >= LIMITS.maxChunkBytes) {
        task.fail("chunk-too-large");
        return;
      }
      if (payload.seq !== task.seq + 1) {
        task.fail("seq-rejected");
        return;
      }
      if (task.bytes + size > LIMITS.maxResponseBytes) {
        task.fail("response-too-large");
        return;
      }
      task.seq = payload.seq;
      task.bytes += size;
      task.parts.push(Buffer.from(payload.data, "utf8"));
      task.onChunk(payload.data);
    }

    function onTerminal(current, payload, event) {
      const keys = event === "error" ? new Set(["taskId", "reason"]) : new Set(["taskId"]);
      if (!allowedKeys(payload, keys)) {
        socket.emit("frame-error", { reason: "unknown-frame" });
        return;
      }
      const task = current.active.get(payload.taskId);
      if (!task) {
        trace.droppedCrossTenant += 1;
        return;
      }
      if (event === "done") {
        task.succeed();
        return;
      }
      const reason = event === "aborted" ? "aborted" : safeReason(payload.reason, "device-error");
      task.fail(reason);
    }
  });

  function admit(session) {
    if (session.activeCount < maxActive) {
      session.activeCount += 1;
      return { ok: true, queued: false };
    }
    if (session.queue.length >= maxQueue) return { ok: false, reason: "queue-full" };
    return { ok: true, queued: true };
  }

  function releaseSlot(session) {
    if (session.queue.length > 0) {
      const next = session.queue.shift();
      send(session, next.input);
      return;
    }
    session.activeCount = Math.max(0, session.activeCount - 1);
  }

  function send(session, input) {
    const task = session.active.get(input.taskId);
    if (!task || task.settled) return;
    task.started = true;
    const remaining = session.exp - Date.now();
    if (remaining <= 0) {
      task.fail("expired");
      return;
    }
    task.arm(Math.min(task.timeoutMs, remaining));
    trace.order.push(`send:${input.taskId}`);
    session.socket.emit("task", {
      taskId: input.taskId,
      prompt: input.prompt,
      model: input.model,
      stream: input.stream === true,
      allowModels: session.models,
      grantExp: session.exp,
    });
  }

  function reserve(input) {
    if (!allowedKeys(input, DISPATCH_KEYS)) return { ok: false, reason: "unknown-frame" };
    if (!TASK_ID.test(String(input.taskId || ""))) return { ok: false, reason: "task-required" };
    if (!NAME_ID.test(String(input.tenantId || "")) || !NAME_ID.test(String(input.deviceId || ""))) {
      return { ok: false, reason: "mapping-required" };
    }
    if (typeof input.prompt !== "string" || byteLength(input.prompt) < 1) return { ok: false, reason: "prompt-required" };
    if (byteLength(input.prompt) > LIMITS.maxPromptBytes) return { ok: false, reason: "prompt-too-large" };
    if (input.stream != null && input.stream !== true && input.stream !== false) return { ok: false, reason: "unknown-frame" };
    if (typeof input.model !== "string" || input.model.length < 1) return { ok: false, reason: "model-rejected" };
    const frameBytes = jsonByteLength({
      taskId: input.taskId,
      prompt: input.prompt,
      model: input.model,
      stream: input.stream === true,
    });
    if (frameBytes >= LIMITS.maxHttpBufferSize) return { ok: false, reason: "frame-too-large" };
    const timeout = resolveTaskTimeout(input.timeoutMs, options.env);
    if (!timeout.ok) return timeout;
    const key = `${input.tenantId}:${input.taskId}`;
    const claimed = idempotency.claim(key);
    if (claimed.state === "done") return { ok: true, duplicate: true, replyHash: claimed.replyHash };
    if (!claimed.ok) return { ok: false, reason: claimed.reason || "duplicate-in-flight" };
    if (!costReceiptOk(input.costReceipt, input)) {
      idempotency.release(key);
      return { ok: false, reason: "cost-not-allocated" };
    }
    const session = devices.get(input.deviceId);
    if (!session || session.tenantId !== input.tenantId) {
      idempotency.release(key);
      return { ok: false, reason: "device-offline" };
    }
    if (!session.models.includes(input.model)) {
      idempotency.release(key);
      return { ok: false, reason: "model-rejected" };
    }
    const untilGrant = session.exp - Date.now();
    if (untilGrant <= 0) {
      idempotency.release(key);
      return { ok: false, reason: "expired" };
    }
    if (typeof options.registerTask !== "function") {
      idempotency.release(key);
      return { ok: false, reason: "task-registration-required" };
    }
    return {
      proceed: true,
      key,
      timeoutMs: Math.min(timeout.timeoutMs, untilGrant),
    };
  }

  function activate(input, signal, onChunk, reserved) {
    const session = devices.get(input.deviceId);
    if (!session || session.tenantId !== input.tenantId) {
      idempotency.release(reserved.key);
      return { ok: false, reason: "device-offline" };
    }
    const admission = admit(session);
    if (!admission.ok) {
      idempotency.release(reserved.key);
      return { ok: false, reason: admission.reason };
    }
    const timeoutMs = reserved.timeoutMs;
    const key = reserved.key;
    let finish = () => {};
    const wait = new Promise((resolve) => {
      finish = resolve;
    });
    const task = {
      seq: 0,
      bytes: 0,
      parts: [],
      started: false,
      settled: false,
      timer: null,
      timeoutMs,
      onChunk: typeof onChunk === "function" ? onChunk : () => {},
      arm(delay) {
        clearTimeout(task.timer);
        task.timer = setTimeout(() => {
          void write(() => task.fail("timeout"));
        }, delay);
      },
      succeed() {
        if (task.settled) return;
        task.settled = true;
        clearTimeout(task.timer);
        session.active.delete(input.taskId);
        const digest = replyHash(task.parts);
        idempotency.complete(key, digest);
        releaseSlot(session);
        finish({ ok: true, replyHash: digest, bytes: task.bytes });
      },
      fail(reason) {
        if (task.settled) return;
        task.settled = true;
        clearTimeout(task.timer);
        session.active.delete(input.taskId);
        idempotency.release(key);
        try {
          session.socket.emit("abort", { taskId: input.taskId });
        } catch {
          // The socket can already be closed.
        }
        if (task.started) releaseSlot(session);
        finish({ ok: false, reason });
      },
      failQueued() {
        if (task.settled) return;
        task.settled = true;
        clearTimeout(task.timer);
        idempotency.release(key);
        finish({ ok: false, reason: "device-disconnected" });
      },
    };
    if (signal) {
      if (typeof signal.addEventListener !== "function") {
        idempotency.release(key);
        if (!admission.queued) session.activeCount = Math.max(0, session.activeCount - 1);
        finish({ ok: false, reason: "signal-rejected" });
        return { wait };
      }
      if (signal.aborted) {
        idempotency.release(key);
        if (!admission.queued) session.activeCount = Math.max(0, session.activeCount - 1);
        finish({ ok: false, reason: "aborted" });
        return { wait };
      }
      signal.addEventListener("abort", () => {
        void write(() => task.fail("aborted"));
      }, { once: true });
    }
    session.active.set(input.taskId, task);
    if (admission.queued) session.queue.push({ input, task, failQueued: () => task.failQueued() });
    else send(session, input);
    return { wait };
  }

  async function dispatchTask(frame, signal, onChunk) {
    const reserved = await write(() => reserve(frame));
    if (!reserved || reserved.proceed !== true) return reserved;
    let registered = null;
    try {
      registered = await options.registerTask({
        taskId: frame.taskId,
        tenantId: frame.tenantId,
        deviceId: frame.deviceId,
      });
    } catch {
      registered = null;
    }
    trace.order.push(`register:${frame.taskId}`);
    const opened = await write(() => {
      const accepted = registered && registered.ok === true
        && registered.taskId === frame.taskId
        && registered.tenantId === frame.tenantId;
      if (!accepted) {
        idempotency.release(reserved.key);
        return { ok: false, reason: "task-not-registered" };
      }
      return activate(frame, signal, onChunk, reserved);
    });
    if (opened && opened.wait) return opened.wait;
    return opened;
  }

  function issue(request, deps = {}) {
    return issueDeviceGrant({
      key: options.key,
      issuer,
      lookupAccount: deps.lookupAccount,
      verifyOwner: deps.verifyOwner,
      registerDevice: deps.registerDevice,
    }, request);
  }

  return {
    available: Boolean(options.key),
    io,
    issue,
    dispatchTask,
    stats() {
      return {
        preAuth: trace.preAuth.slice(),
        droppedCrossTenant: trace.droppedCrossTenant,
        credentialQuery: trace.credentialQuery,
        order: trace.order.slice(),
        devices: devices.size,
        limits: { maxActive, maxQueue, maxHttpBufferSize: LIMITS.maxHttpBufferSize },
      };
    },
    async close() {
      for (const session of devices.values()) session.socket.disconnect(true);
      await io.close();
    },
  };
}
