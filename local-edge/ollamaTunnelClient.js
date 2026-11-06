import { io } from "socket.io-client";
import { executeFrame } from "./ollamaGenerate.js";
import { createLocalStatusApi, NGROK_CONNECTOR } from "./localStatusApi.js";
import {
  createBoundedQueue,
  resolveCloudPolicy,
  resolveTestTransport,
  validateTunnelUrl,
} from "./tunnelEndpoint.js";

export { executeFrame, createLocalStatusApi, NGROK_CONNECTOR, validateTunnelUrl, resolveTestTransport, resolveCloudPolicy };

const DEFAULT_URL = "wss://eliza-valhalla.onrender.com";

export const TUNNEL_HOOKS = [
  "Do not edit valhallaMasterEngineV35.js in this change.",
  "Start createOllamaTunnelClient on the owner PC with a server-issued device grant.",
  "The client connects to wss://eliza-valhalla.onrender.com and uses the Socket.IO path /relay.",
  "An https URL for that host is converted to wss. Other hosts are rejected.",
  "The first socket message is the auth frame. The grant is not a query parameter.",
  "The client calls only http://127.0.0.1:11434/api/generate.",
  "The model must be an exact name in the device grant list.",
  "stream false is the default. stream true reads NDJSON and requires a final done record.",
  "Tool calls are inert. This client does not run shell commands.",
  "When the device is offline, call the policy callback.",
  "Cloud work runs only when that callback returns runCloud true and authorized true.",
  "This client does not wake the PC and does not write wake settings.",
  "The ngrok connector is not installed and does not listen on port 11434.",
].join("\n");

function waitFor(emitter, events) {
  return new Promise((resolve) => {
    const clean = [];
    for (const event of events) {
      const handler = (payload) => {
        for (const item of clean) emitter.off(item.event, item.handler);
        resolve({ event, payload });
      };
      clean.push({ event, handler });
      emitter.on(event, handler);
    }
  });
}

export function createOllamaTunnelClient(options = {}) {
  let grant = typeof options.grant === "string" ? options.grant : "";
  let socket = null;
  let generation = 0;
  let authenticated = false;
  let stopped = false;
  let asleep = false;
  let attempts = 0;
  const maxAttempts = options.maxAttempts ?? 3;
  const outbound = createBoundedQueue(options.maxQueue ?? 5);
  const aborts = new Map();
  let current = { available: false, state: "offline", reason: "offline", runCloud: false };
  const run = options.executeFrame || executeFrame;

  function setState(next) {
    current = next;
    if (typeof options.onState === "function") options.onState(next);
    return current;
  }

  async function failOffline(reason) {
    const decision = await resolveCloudPolicy(options.cloudPolicy, reason);
    return setState({
      available: false,
      state: asleep ? "asleep" : "offline",
      reason,
      runCloud: decision.runCloud === true,
    });
  }

  function endpoint() {
    if (options.testTransport === true) return resolveTestTransport(options.url, options.env || process.env);
    return validateTunnelUrl(options.url || DEFAULT_URL);
  }

  async function onDisconnect(ticket) {
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
    outbound.clear();
    authenticated = false;
    if (stopped || asleep || ticket !== generation) return;
    if (typeof options.renewGrant !== "function" || attempts >= maxAttempts) {
      await failOffline(asleep ? "device-asleep" : "offline");
      return;
    }
    attempts += 1;
    setState({ available: false, state: "reconnecting", reason: "offline", runCloud: false });
    const next = await options.renewGrant({ attempt: attempts });
    if (ticket !== generation || typeof next !== "string") {
      await failOffline("offline");
      return;
    }
    grant = next;
    await connect();
  }

  async function runTask(frame) {
    const controller = new AbortController();
    if (frame && frame.taskId) aborts.set(frame.taskId, controller);
    let seq = 0;
    try {
      const result = await run(frame, controller.signal, (chunk) => {
        const queued = outbound.push(chunk);
        if (!queued.ok || !socket || socket.connected !== true) {
          controller.abort();
          throw new Error(queued.ok ? "offline" : "queue-full");
        }
        seq += 1;
        socket.emit("chunk", { taskId: frame.taskId, seq, data: chunk });
        outbound.shift();
      }, {
        fetchImpl: options.fetchImpl,
        allowModels: frame && frame.allowModels,
        grantExp: frame && frame.grantExp,
        timeoutMs: frame && frame.timeoutMs,
      });
      if (!socket || socket.connected !== true) return;
      if (controller.signal.aborted) {
        socket.emit("aborted", { taskId: frame.taskId });
        return;
      }
      if (!result || result.ok !== true) {
        socket.emit("error", { taskId: frame.taskId, reason: result && result.reason ? result.reason : "device-error" });
        return;
      }
      socket.emit("done", { taskId: frame.taskId });
    } catch {
      if (socket && socket.connected === true && frame && frame.taskId) {
        socket.emit(controller.signal.aborted ? "aborted" : "error", {
          taskId: frame.taskId,
          reason: controller.signal.aborted ? "aborted" : "device-error",
        });
      }
    } finally {
      if (frame && frame.taskId) aborts.delete(frame.taskId);
    }
  }

  async function connect() {
    if (asleep) return failOffline("device-asleep");
    const target = endpoint();
    if (!target.ok) return failOffline(target.reason);
    if (typeof grant !== "string" || grant.length < 20) return failOffline("grant-required");
    const ticket = ++generation;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    setState({ available: false, state: "connecting", reason: null, runCloud: false });
    const next = io(target.url, {
      path: target.path,
      transports: ["websocket", "polling"],
      reconnection: false,
      timeout: 5000,
      forceNew: true,
    });
    socket = next;
    next.on("task", (frame) => {
      void runTask(frame);
    });
    next.on("abort", (message) => {
      if (message && aborts.has(message.taskId)) aborts.get(message.taskId).abort();
    });
    next.on("disconnect", () => {
      if (ticket !== generation || !authenticated) return;
      void onDisconnect(ticket);
    });
    const connected = await waitFor(next, ["connect", "connect_error"]);
    if (ticket !== generation) return current;
    if (connected.event !== "connect") {
      next.disconnect();
      return failOffline("offline");
    }
    next.emit("auth", { grant });
    const authed = await waitFor(next, ["auth-ok", "auth-no", "disconnect"]);
    if (ticket !== generation) return current;
    if (authed.event !== "auth-ok") {
      next.disconnect();
      return failOffline(authed.payload && authed.payload.reason ? authed.payload.reason : "auth-failed");
    }
    authenticated = true;
    attempts = 0;
    return setState({ available: true, state: "authenticated", reason: null, runCloud: false });
  }

  function markAsleep() {
    asleep = true;
    stopped = true;
    generation += 1;
    for (const controller of aborts.values()) controller.abort();
    aborts.clear();
    if (socket) socket.disconnect();
    return setState({ available: false, state: "asleep", reason: "device-asleep", runCloud: false });
  }

  return {
    connect,
    markAsleep,
    state: () => current,
    socket: () => socket,
    ngrok: NGROK_CONNECTOR,
    async close() {
      stopped = true;
      generation += 1;
      for (const controller of aborts.values()) controller.abort();
      if (socket) socket.disconnect();
    },
  };
}
