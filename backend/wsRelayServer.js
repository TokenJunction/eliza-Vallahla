import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Device-outbound WebSocket relay. Not mounted by the main engine.
// createRelayServer does not listen and does not dial a customer PC.
// Production refuses cleartext ws. A loopback listener exists only for tests.
// TLS fields are a client scaffold. Offline tests do not prove a public certificate.
//
// External HTTP and Jupiter calls use a timeout of at most 5 seconds.
// A local model stream is a separate deadline. Real local generation can
// be slower than 5 seconds, so the local default is 30 seconds.

const requireFromEdge = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../local-edge/package.json"));

export const DEFAULT_MAX_BODY = 256 * 1024;
export const HARD_MAX_BODY = 512 * 1024;
export const AUTH_TIMEOUT_MS = 5_000;
export const EXTERNAL_TIMEOUT_MAX_MS = 5_000;
export const LOCAL_STREAM_DEADLINE_MS = 30_000;
const DEFAULT_MAX_FRAMES = 2048;
const OPAQUE = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN_QUERY = new Set(["token", "access_token", "grant", "jwt", "secret", "ticket", "code", "auth"]);

function loadWs() {
  try {
    return requireFromEdge("ws");
  } catch {
    const error = new Error("ws_package_missing");
    error.code = "ws_package_missing";
    throw error;
  }
}

export function resolveTimeouts(config = {}) {
  const external = config.externalTimeoutMs === undefined ? EXTERNAL_TIMEOUT_MAX_MS : config.externalTimeoutMs;
  if (!Number.isSafeInteger(external) || external < 1 || external > EXTERNAL_TIMEOUT_MAX_MS) {
    throw new RangeError("external_timeout_exceeds_5s");
  }
  const local = config.localStreamDeadlineMs === undefined ? LOCAL_STREAM_DEADLINE_MS : config.localStreamDeadlineMs;
  if (!Number.isSafeInteger(local) || local < 1_000 || local > 120_000) {
    throw new RangeError("local_deadline_out_of_bounds");
  }
  return Object.freeze({
    externalTimeoutMs: external,
    localStreamDeadlineMs: local,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
}

function bodyLimit(maxBodyBytes) {
  const max = maxBodyBytes === undefined ? DEFAULT_MAX_BODY : maxBodyBytes;
  if (!Number.isSafeInteger(max) || max < 1024 || max > HARD_MAX_BODY) throw new RangeError("max_body_out_of_bounds");
  return max;
}

export function assertTransportUrl(url, { production = true, allowDevLoopbackWs = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "url_invalid" }; }
  if (parsed.username || parsed.password) return { ok: false, reason: "credentials_in_url" };
  const credential = queryHasCredential(parsed);
  if (credential) return { ok: false, reason: credential };
  if (parsed.protocol === "wss:") {
    return { ok: true, url: parsed.toString(), tlsRequired: true, servername: parsed.hostname };
  }
  if (parsed.protocol !== "ws:") return { ok: false, reason: "scheme_not_allowed" };
  if (production !== false) return { ok: false, reason: "ws_refused_in_production" };
  if (allowDevLoopbackWs !== true) return { ok: false, reason: "ws_requires_explicit_dev_opt_in" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopback(host)) return { ok: false, reason: "ws_only_loopback" };
  return { ok: true, url: parsed.toString(), tlsRequired: false, devOnly: true, servername: host };
}

function queryHasCredential(parsed) {
  for (const key of parsed.searchParams.keys()) {
    if (TOKEN_QUERY.has(String(key).toLowerCase())) return "query_token_refused";
  }
  return "";
}

function isLoopback(address) {
  const host = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1" || host === "localhost";
}

function isJwt(value) {
  return typeof value === "string" && value.length > 20 && value.split(".").length === 3;
}

export function deviceSocketOptions(url, { production = true, allowDevLoopbackWs = false, headers = {} } = {}) {
  const gate = assertTransportUrl(url, { production, allowDevLoopbackWs });
  if (!gate.ok) return gate;
  const safe = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (/^cookie$/i.test(key)) return { ok: false, reason: "cookie_header_refused" };
      if (/authorization/i.test(key)) return { ok: false, reason: "authorization_header_refused" };
      safe[key] = String(value);
    }
  }
  return {
    ok: true,
    url: gate.url,
    rejectUnauthorized: true,
    servername: gate.servername,
    headers: safe,
    browserWebSocket: false,
    tlsProven: false,
  };
}

export function acceptTextFrame(raw, lim, alreadyBytes = 0) {
  let bytes = 0;
  let text = "";
  if (Buffer.isBuffer(raw)) {
    bytes = raw.length;
    if (bytes > lim.maxBodyBytes) return { ok: false, reason: "frame_too_large", bytes, parsed: false };
    if (!Number.isSafeInteger(alreadyBytes) || alreadyBytes + bytes > lim.maxBodyBytes) {
      return { ok: false, reason: "stream_too_large", bytes, parsed: false };
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return { ok: false, reason: "frame_not_utf8", bytes, parsed: false };
    }
  } else if (typeof raw === "string") {
    bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > lim.maxBodyBytes) return { ok: false, reason: "frame_too_large", bytes, parsed: false };
    if (!Number.isSafeInteger(alreadyBytes) || alreadyBytes + bytes > lim.maxBodyBytes) {
      return { ok: false, reason: "stream_too_large", bytes, parsed: false };
    }
    text = raw;
  } else {
    return { ok: false, reason: "frame_not_text", bytes: 0, parsed: false };
  }
  let frame;
  try { frame = JSON.parse(text); } catch { return { ok: false, reason: "frame_not_json", bytes, parsed: true }; }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { ok: false, reason: "frame_not_object", bytes, parsed: true };
  }
  return { ok: true, frame, bytes, parsed: true };
}

function redactedHandle(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function createStream(requestId, lim, deadline, taskId, grantId) {
  return {
    requestId,
    grantId,
    taskId,
    lim,
    deadline,
    nextSeq: 0,
    bytes: 0,
    frames: 0,
    state: "open",
    cancelRequested: false,
    text: "",
    outcome: null,
    released: false,
  };
}

function acceptStreamFrame(stream, frame, bytes) {
  if (stream.state !== "open") {
    return { ok: false, reason: "frame_after_terminal", outcome: stream.outcome };
  }
  if (frame.requestId !== stream.requestId) return closeStream(stream, "request_id_mismatch");
  if (!Number.isSafeInteger(frame.seq) || frame.seq !== stream.nextSeq) return closeStream(stream, "seq_not_monotonic");
  stream.nextSeq += 1;
  stream.frames += 1;
  stream.bytes += bytes;
  if (stream.frames > stream.lim.maxFrames) return closeStream(stream, "too_many_frames");
  if (stream.bytes > stream.lim.maxBodyBytes) return closeStream(stream, "stream_too_large");
  if (frame.type === "progress") {
    if (typeof frame.delta !== "string") return closeStream(stream, "bad_progress");
    stream.text += frame.delta;
    return { ok: true, state: stream.state };
  }
  if (!["result", "error", "cancelled"].includes(frame.type)) return closeStream(stream, "unknown_frame_type");
  stream.state = "closed";
  if (frame.type === "result") {
    if (stream.cancelRequested) {
      stream.text = "";
      stream.outcome = { status: "cancelled", completed: false, content: null };
    } else if (frame.done !== true || typeof frame.content !== "string" || frame.content.trim().length === 0) {
      stream.text = "";
      stream.outcome = { status: "failed", completed: false, content: null, reason: "incomplete_result" };
    } else {
      stream.outcome = { status: "completed", completed: true, content: frame.content };
    }
  } else if (frame.type === "cancelled") {
    stream.text = "";
    stream.outcome = { status: "cancelled", completed: false, content: null };
  } else {
    stream.text = "";
    stream.outcome = { status: "failed", completed: false, content: null, reason: typeof frame.reason === "string" ? frame.reason.slice(0, 64) : "device_error" };
  }
  return { ok: true, state: "closed", outcome: stream.outcome };
}

function closeStream(stream, reason) {
  stream.state = "closed";
  stream.text = "";
  stream.outcome = { status: "failed", completed: false, content: null, reason };
  return { ok: false, reason, outcome: stream.outcome };
}

export function createRelayServer({
  server,
  production = true,
  allowDevLoopbackWs = false,
  maxBodyBytes,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxConnections = 32,
  idleTimeoutMs = 60_000,
  clock = { now: () => Date.now() },
  manualClock = false,
  timeouts: timeoutConfig,
  authenticate,
  consumeGrant,
  fingerprintOf,
  releaseReservation,
  sessionActive,
} = {}) {
  if (!server || typeof server.on !== "function") throw new TypeError("http_server_required");
  const maxBody = bodyLimit(maxBodyBytes);
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 100_000) throw new RangeError("max_frames_out_of_bounds");
  const timeouts = resolveTimeouts(timeoutConfig || {});
  const lim = Object.freeze({ maxBodyBytes: maxBody, maxFrames });
  const { WebSocketServer } = loadWs();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBody, perMessageDeflate: false });
  wss.on("error", () => {});
  const connections = new Map();

  function settle(conn, stream) {
    if (!stream || stream.released) return;
    stream.released = true;
    conn.reserved = Math.max(0, conn.reserved - 1);
    if (typeof releaseReservation !== "function") return;
    try { releaseReservation({ grantId: stream.grantId, taskId: stream.taskId, requestId: stream.requestId }); }
    catch { /* the local hold is already gone */ }
  }

  function endSocket(conn, code, reason) {
    if (!conn || conn.closing) return;
    conn.closing = true;
    connections.delete(conn.connectionId);
    for (const stream of conn.streams.values()) settle(conn, stream);
    try { conn.socket.close(code, reason); } catch { /* socket already gone */ }
  }

  function send(conn, payload) {
    if (!conn.socket || conn.socket.readyState !== 1) return false;
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, "utf8") > lim.maxBodyBytes) return false;
    try { conn.socket.send(text); return true; } catch { return false; }
  }

  function wipeRevoked(conn) {
    conn.sessionRevoked = true;
    for (const stream of conn.streams.values()) {
      if (stream.state === "open") {
        stream.state = "closed";
        stream.text = "";
        stream.outcome = { status: "revoked", completed: false, content: null, reason: "session_revoked" };
        settle(conn, stream);
      }
    }
  }

  function handleAuth(conn, frame) {
    if (!frame || frame.type !== "auth") {
      endSocket(conn, 4003, "auth_required");
      return;
    }
    if (isJwt(frame.token)) {
      endSocket(conn, 4003, "jwt_not_used");
      return;
    }
    if (typeof frame.token !== "string" || !OPAQUE.test(frame.token)) {
      endSocket(conn, 4003, "token_not_opaque");
      return;
    }
    const handle = redactedHandle(frame.token);
    let result;
    try {
      result = typeof authenticate === "function" ? authenticate(frame.token, { handle }) : null;
    } catch {
      endSocket(conn, 4003, "auth_failed");
      return;
    }
    if (!result || result.ok !== true) {
      endSocket(conn, 4003, "auth_failed");
      return;
    }
    if (typeof result.subject !== "string" || typeof result.tenantId !== "string" || typeof result.deviceId !== "string" || typeof result.activeId !== "string") {
      endSocket(conn, 4003, "auth_failed");
      return;
    }
    connections.delete(conn.connectionId);
    conn.authed = true;
    conn.handle = handle;
    conn.subject = result.subject;
    conn.tenantId = result.tenantId;
    conn.deviceId = result.deviceId;
    conn.activeId = result.activeId;
    conn.sessionVersion = result.sessionVersion;
    conn.deviceVersion = result.deviceVersion;
    conn.connectionId = "con_" + randomBytes(12).toString("base64url");
    connections.set(conn.connectionId, conn);
    send(conn, {
      type: "authenticated",
      connectionId: conn.connectionId,
      deviceId: conn.deviceId,
      tenantId: conn.tenantId,
      subject: conn.subject,
      activeId: conn.activeId,
    });
  }

  function handleDeviceFrame(conn, frame, bytes) {
    if (frame.type === "auth") {
      send(conn, { type: "error", reason: "auth_already_complete" });
      return;
    }
    if (frame.type === "execute" || frame.type === "cancel") {
      send(conn, { type: "error", reason: "device_cannot_invoke" });
      return;
    }
    if (!["progress", "result", "error", "cancelled"].includes(frame.type)) {
      send(conn, { type: "error", reason: "unknown_frame_type" });
      return;
    }
    if (frame.activeId !== conn.activeId || frame.deviceId !== conn.deviceId) {
      send(conn, { type: "error", reason: "binding_mismatch", requestId: frame.requestId });
      return;
    }
    if (conn.sessionRevoked) {
      send(conn, { type: "error", reason: "session_revoked", requestId: frame.requestId });
      return;
    }
    const stream = conn.streams.get(frame.requestId);
    if (!stream) {
      send(conn, { type: "error", reason: "unknown_request", requestId: frame.requestId });
      return;
    }
    const accepted = acceptStreamFrame(stream, frame, bytes);
    if (stream.state === "closed") settle(conn, stream);
    if (!accepted.ok) send(conn, { type: "error", reason: accepted.reason, requestId: frame.requestId });
  }

  function onMessage(conn, raw) {
    try {
      const parsed = acceptTextFrame(raw, lim, conn.streamBytes);
      conn.frames += 1;
      if (!parsed.ok) {
        if (Number.isSafeInteger(parsed.bytes)) conn.streamBytes += parsed.bytes;
        if (!conn.authed) endSocket(conn, 4003, parsed.reason);
        else send(conn, { type: "error", reason: parsed.reason });
        if (conn.streamBytes > lim.maxBodyBytes || conn.frames > lim.maxFrames) endSocket(conn, 4009, parsed.reason);
        return;
      }
      conn.streamBytes += parsed.bytes;
      conn.lastSeen = clock.now();
      if (!conn.authed) handleAuth(conn, parsed.frame);
      else handleDeviceFrame(conn, parsed.frame, parsed.bytes);
    } catch {
      try { send(conn, { type: "error", reason: "internal_rejected" }); } catch { /* do not crash the process */ }
    }
  }

  server.on("upgrade", (req, socket, head) => {
    try {
      if (connections.size >= maxConnections) {
        socket.destroy();
        return;
      }
      let parsed;
      try { parsed = new URL(req.url || "/", "http://127.0.0.1"); } catch { socket.destroy(); return; }
      if (queryHasCredential(parsed) || parsed.username || parsed.password) {
        socket.destroy();
        return;
      }
      const encrypted = Boolean(req.socket && req.socket.encrypted);
      if (!encrypted) {
        const remote = req.socket && req.socket.remoteAddress;
        if (!(production === false && allowDevLoopbackWs === true && isLoopback(remote))) {
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = {
          socket: ws,
          connectionId: "pend_" + randomBytes(9).toString("base64url"),
          authed: false,
          authDeadline: clock.now() + AUTH_TIMEOUT_MS,
          lastSeen: clock.now(),
          streamBytes: 0,
          frames: 0,
          streams: new Map(),
          reserved: 0,
          sessionRevoked: false,
          closing: false,
        };
        connections.set(conn.connectionId, conn);
        ws.on("message", (data) => onMessage(conn, data));
        ws.on("error", () => { conn.errors = (conn.errors || 0) + 1; });
        ws.on("close", () => {
          connections.delete(conn.connectionId);
          for (const stream of conn.streams.values()) settle(conn, stream);
        });
      });
    } catch {
      try { socket.destroy(); } catch { /* refuse the socket without a process crash */ }
    }
  });

  function tick(now = clock.now()) {
    for (const conn of [...connections.values()]) {
      if (!conn.authed && now >= conn.authDeadline) {
        endSocket(conn, 4001, "auth_timeout");
        continue;
      }
      if (conn.authed && now - conn.lastSeen >= idleTimeoutMs) {
        endSocket(conn, 4002, "idle_timeout");
        continue;
      }
      if (conn.authed && typeof sessionActive === "function") {
        let live = false;
        try { live = sessionActive(conn.subject, conn.tenantId) === true; } catch { live = false; }
        if (!live) wipeRevoked(conn);
      }
      for (const stream of [...conn.streams.values()]) {
        if (stream.state === "open" && now >= stream.deadline) {
          stream.state = "closed";
          stream.text = "";
          stream.outcome = { status: "expired", completed: false, content: null, reason: "grant_expired" };
          settle(conn, stream);
        }
      }
    }
    return stats();
  }

  function dispatch(input = {}) {
    const conn = connections.get(input.connectionId);
    if (!conn || !conn.authed) return { ok: false, dispatched: false, modelInvoked: false, reason: "device_not_connected" };
    if (conn.sessionRevoked) return { ok: false, dispatched: false, modelInvoked: false, reason: "session_revoked" };
    if (input.activeId !== conn.activeId || input.deviceId !== conn.deviceId) {
      return { ok: false, dispatched: false, modelInvoked: false, reason: "binding_mismatch" };
    }
    if (typeof fingerprintOf !== "function" || typeof consumeGrant !== "function") {
      return { ok: false, dispatched: false, modelInvoked: false, reason: "grant_checker_required" };
    }
    let printed;
    try {
      printed = fingerprintOf(input.capability, input.request);
    } catch (error) {
      return { ok: false, dispatched: false, modelInvoked: false, reason: error && error.message ? error.message : "bad_request" };
    }
    if (!printed || printed.ok !== true) {
      return { ok: false, dispatched: false, modelInvoked: false, reason: printed && printed.reason ? printed.reason : "bad_request" };
    }
    const now = Number.isSafeInteger(input.now) ? input.now : clock.now();
    let consumed;
    try {
      consumed = consumeGrant({
        grantId: input.grantId,
        nonce: input.nonce,
        fingerprint: printed.fingerprint,
        capability: input.capability,
        now,
        connection: {
          authenticated: true,
          active: true,
          tenantId: conn.tenantId,
          subject: conn.subject,
          deviceId: conn.deviceId,
          connectionId: conn.connectionId,
          activeId: conn.activeId,
          sessionVersion: conn.sessionVersion,
          deviceVersion: conn.deviceVersion,
        },
      });
    } catch {
      return { ok: false, dispatched: false, modelInvoked: false, reason: "grant_check_failed" };
    }
    if (!consumed || consumed.ok !== true) {
      return { ok: false, dispatched: false, modelInvoked: false, reason: consumed && consumed.reason ? consumed.reason : "grant_rejected" };
    }
    const stream = createStream(input.grantId, lim, now + timeouts.localStreamDeadlineMs, input.taskId, input.grantId);
    conn.streams.set(input.grantId, stream);
    conn.reserved += 1;
    send(conn, {
      type: "execute",
      requestId: input.grantId,
      taskId: input.taskId,
      activeId: conn.activeId,
      deviceId: conn.deviceId,
      capability: input.capability,
      expiresAt: consumed.grant && consumed.grant.expiresAt,
      request: printed.request,
    });
    return { ok: true, dispatched: true, modelInvoked: false, requestId: input.grantId };
  }

  function cancel(connectionId, requestId) {
    const conn = connections.get(connectionId);
    if (!conn || !conn.authed) return { ok: false, deviceClosed: false, reason: "device_not_connected" };
    const stream = conn.streams.get(requestId);
    if (!stream) return { ok: false, deviceClosed: false, reason: "unknown_request" };
    if (stream.state === "open") stream.cancelRequested = true;
    send(conn, { type: "cancel", requestId });
    return { ok: true, deviceClosed: false, socketOpen: conn.socket.readyState === 1 };
  }

  function stats() {
    let reserved = 0;
    const handles = [];
    for (const conn of connections.values()) {
      reserved += conn.reserved;
      if (conn.handle) handles.push(conn.handle);
    }
    return {
      connections: connections.size,
      reserved,
      handles,
      production: production !== false,
      tlsRequired: production !== false,
      listenerStartedByFactory: false,
      externalTimeoutMs: timeouts.externalTimeoutMs,
      localStreamDeadlineMs: timeouts.localStreamDeadlineMs,
    };
  }

  let timer = null;
  if (!manualClock) {
    timer = setInterval(() => { try { tick(clock.now()); } catch { /* timer must not crash the process */ } }, 250);
    if (typeof timer.unref === "function") timer.unref();
  }

  function close() {
    if (timer) clearInterval(timer);
    for (const conn of [...connections.values()]) endSocket(conn, 1001, "server_close");
    return new Promise((resolve) => {
      wss.close(() => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      });
    });
  }

  return {
    server,
    production: production !== false,
    allowDevLoopbackWs: allowDevLoopbackWs === true,
    timeouts,
    dispatch,
    cancel,
    tick,
    close,
    stats,
    markSessionRevoked(connectionId) {
      const conn = connections.get(connectionId);
      if (!conn) return { ok: false, reason: "device_not_connected" };
      wipeRevoked(conn);
      return { ok: true, content: null };
    },
    streamOutcome(connectionId, requestId) {
      const conn = connections.get(connectionId);
      const stream = conn && conn.streams.get(requestId);
      if (!stream) return { status: "missing", completed: false, content: null };
      return stream.outcome || { status: stream.state, completed: false, content: null, text: stream.text };
    },
  };
}

export function listenLoopback(relay) {
  if (!relay || relay.production !== false || relay.allowDevLoopbackWs !== true) {
    throw new Error("production_listener_refused");
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    relay.server.once("error", onError);
    relay.server.listen(0, "127.0.0.1", () => {
      relay.server.off("error", onError);
      const address = relay.server.address();
      if (!address || address.address !== "127.0.0.1") {
        relay.server.close(() => reject(new Error("listener_not_loopback")));
        return;
      }
      resolve({ host: "127.0.0.1", port: address.port });
    });
  });
}
