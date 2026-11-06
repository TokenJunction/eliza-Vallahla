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

export function tasksRequest(site, token, payload) {
  var base = String((site && site.AGENT_API_URL) || "").replace(/\/$/, "");
  if (!token || base.indexOf("https://") !== 0) return null;
  return {
    url: base + "/api/v1/tasks",
    credentials: "omit",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: payload,
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
