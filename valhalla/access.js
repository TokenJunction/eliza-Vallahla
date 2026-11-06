export function normalizeAccess(body) {
  if (!body || body.ok !== true) return { ok: false };
  return {
    ok: true,
    plan: body.plan === "pro" ? "pro" : "free",
    subscriber: body.subscriber === true,
    leader: body.leader === true,
  };
}

export function accessRequest(site, token) {
  var base = String((site && site.AUTH_URL) || "").replace(/\/$/, "");
  if (!token || base.indexOf("https://") !== 0) return null;
  return {
    url: base + "/auth/access",
    credentials: "omit",
    headers: { authorization: "Bearer " + token },
  };
}

export var LIVE_TASK_CAPABILITIES = ["voice", "reasoning", "paper", "view"];

export function taskContractBlock(payload) {
  if (!payload || !payload.conversationId) {
    return "The server has not issued a conversation id. The command was not sent.";
  }
  if (LIVE_TASK_CAPABILITIES.indexOf(payload.capability) < 0) {
    return "Capability chat is not in the current server allow-list. It was not sent as view or reasoning.";
  }
  return "";
}

export function serializeTaskBody(payload) {
  return JSON.stringify(payload);
}

export function tasksRequest(site, token, payload) {
  var base = String((site && site.AGENT_API_URL) || "").replace(/\/$/, "");
  if (!token || base.indexOf("https://") !== 0 || taskContractBlock(payload)) return null;
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
  if (!body || body.ok !== true || body.status !== "completed") return null;
  if (typeof body.text !== "string" || !body.text.trim()) return null;
  return body.text;
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
