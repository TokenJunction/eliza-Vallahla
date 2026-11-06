import { serviceOrigin } from "./origins.js";

export function normalizeAccess(body) {
  if (!body || body.ok !== true) return { ok: false };
  return {
    ok: true,
    plan: body.plan === "pro" ? "pro" : "free",
    subscriber: body.subscriber === true,
    leader: body.leader === true,
  };
}

export function accessRequest(site, token, pageHost) {
  var base = serviceOrigin(site && site.AUTH_URL, pageHost);
  if (!token || !base) return null;
  return {
    url: base + "/auth/access",
    credentials: "omit",
    headers: { authorization: "Bearer " + token },
  };
}

export var LIVE_TASK_CAPABILITIES = ["voice", "reasoning", "paper", "view"];

export function taskContractBlock(payload) {
  if (!payload) return "The command was not sent.";
  if (payload.conversationId === "0" || payload.conversationId === "LOCAL_CURATED") {
    return "That conversation id is not from the server. The command was not sent.";
  }
  if (LIVE_TASK_CAPABILITIES.indexOf(payload.capability) < 0) {
    return "Capability chat is not in the current server allow-list. It was not sent as view or reasoning.";
  }
  return "";
}

export function serializeTaskBody(payload) {
  return JSON.stringify(payload);
}

export function tasksRequest(site, token, payload, pageHost) {
  var base = serviceOrigin(site && site.AGENT_API_URL, pageHost);
  if (!token || !base || taskContractBlock(payload)) return null;
  return {
    url: base + "/api/v1/tasks",
    credentials: "omit",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: serializeTaskBody(payload),
  };
}

export var TASK_POLL_MS = 3000;
export var TASK_POLL_MAX_MS = 120000;

export function taskIdOf(body) {
  var record = body && body.task && typeof body.task === "object" ? body.task : body;
  var id = record && record.taskId;
  return /^[0-9a-f]{32}$/.test(String(id || "")) ? String(id) : "";
}

export function taskState(httpStatus, body) {
  var record = body && body.task && typeof body.task === "object" ? body.task : body;
  var id = taskIdOf(record);
  if (httpStatus === 202) return { state: "pending", taskId: id, text: "", code: 202 };
  if (!(httpStatus >= 200 && httpStatus < 300)) {
    return { state: "failed", taskId: id, text: "", code: httpStatus };
  }
  if (!record || record.ok !== true) {
    var rejected = record && (record.state || record.status);
    if (rejected === "cancelled" || rejected === "cancel_requested") {
      return { state: "cancel_requested", taskId: id, text: "", code: httpStatus };
    }
    return { state: "failed", taskId: id, text: "", code: httpStatus };
  }
  var state = record.state || record.status;
  if (state === "running" || state === "pending") {
    return { state: "pending", taskId: id, text: "", code: httpStatus };
  }
  if (state === "cancelled" || state === "cancel_requested") {
    return { state: "cancel_requested", taskId: id, text: "", code: httpStatus };
  }
  if (state === "done") {
    var text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return { state: "failed", taskId: id, text: "", code: httpStatus };
    return { state: "done", taskId: id, text: text, code: httpStatus };
  }
  return { state: "failed", taskId: id, text: "", code: httpStatus };
}

export function stopState(httpStatus, body) {
  var id = body && /^[0-9a-f]{32}$/.test(String(body.taskId || "")) ? String(body.taskId) : "";
  if (!(httpStatus >= 200 && httpStatus < 300) || !body || body.ok !== true) {
    return { state: "failed", taskId: id, code: httpStatus };
  }
  if (body.state === "cancelled" || body.reason === "cancelled") {
    return { state: "cancel_requested", taskId: id || String(body.taskId || ""), code: httpStatus };
  }
  if (body.state === "done") return { state: "done", taskId: id || String(body.taskId || ""), code: httpStatus };
  return { state: "failed", taskId: id, code: httpStatus };
}

export function taskReadRequest(site, token, taskId, pageHost) {
  var base = serviceOrigin(site && site.AGENT_API_URL, pageHost);
  if (!token || !base || !/^[0-9a-f]{32}$/.test(String(taskId || ""))) return null;
  return {
    url: base + "/api/v1/tasks/" + taskId,
    credentials: "omit",
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  };
}

export function taskHistoryRequest(site, token, conversationId, pageHost) {
  var id = String(conversationId || "");
  if (!id || id === "0" || id === "LOCAL_CURATED") return null;
  var base = serviceOrigin(site && site.AGENT_API_URL, pageHost);
  if (!token || !base) return null;
  return {
    url: base + "/api/v1/tasks?conversationId=" + encodeURIComponent(id),
    credentials: "omit",
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  };
}

export function commandPayload(text, conversationId) {
  var body = {
    text: String(text || ""),
    capability: "chat",
    app: "ai-workspace",
    tool: "none",
  };
  if (conversationId) body.conversationId = String(conversationId);
  return body;
}

export function replyText(body) {
  var parsed = taskState(200, body);
  return parsed.state === "done" ? parsed.text : null;
}

export function healthReady(body) {
  if (!body || typeof body !== "object") return false;
  if (body.ready === true) return true;
  var components = body.components;
  if (!components || typeof components !== "object" || Array.isArray(components)) return false;
  var names = Object.keys(components);
  if (!names.length) return false;
  return names.every(function (name) {
    var value = components[name];
    return value === true || value === "ok" || (value && value.ready === true);
  });
}

function localHost(host) {
  var name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
  if (/^127\./.test(name) || /^10\./.test(name) || /^192\.168\./.test(name) || /^169\.254\./.test(name)) return true;
  var parts = name.split(".");
  if (parts[0] === "172") {
    var second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function publicWebUrl(input) {
  var raw = String(input || "").trim();
  if (!raw || /^(javascript|data|file|blob):/i.test(raw)) {
    return { ok: false, message: "That address is blocked." };
  }
  var url;
  try {
    url = new URL(raw);
  } catch (error) {
    return { ok: false, message: "Enter a public https address." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Addresses with sign-in details are blocked." };
  }
  if (localHost(url.hostname)) {
    return { ok: false, message: "Local and private addresses are blocked." };
  }
  if (/token|key|secret|password|auth/i.test(url.search)) {
    return { ok: false, message: "Addresses that carry a key are blocked." };
  }
  var display = url.origin + url.pathname;
  if (url.protocol === "http:") {
    return { ok: false, http: true, url: url.href, display: display, message: "HTTP is not opened unless you confirm it. Nothing was opened." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "Only a public https address can be opened." };
  }
  return { ok: true, url: url.href, display: display };
}
