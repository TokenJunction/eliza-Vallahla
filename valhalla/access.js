export function normalizeAccess(body) {
  if (!body || body.ok !== true) return { ok: false };
  return {
    ok: true,
    plan: body.plan === "pro" ? "pro" : "free",
    subscriber: body.subscriber === true,
    leader: body.leader === true,
  };
}

export function commandPayload(text) {
  return {
    text: String(text || ""),
    capability: "view",
    app: "ai-workspace",
    tool: "none",
    conversationId: "0",
  };
}

export function replyText(body) {
  if (!body || body.ok !== true || body.status !== "completed") return null;
  if (typeof body.text !== "string" || !body.text.trim()) return null;
  return body.text;
}
