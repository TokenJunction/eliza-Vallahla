import { randomBytes } from "node:crypto";
import { safeEqual } from "./commerce.js";
import { assertPublicTarget } from "./ssrf.js";
import { redact, encryptSecret } from "./secretStore.js";
import { admit } from "./task-invocation.js";

// Optional Telegram and X scaffold. No network calls. No shared Wren or Grok credentials.
// Pending: BotFather setup, live setWebhook, X OAuth, and any send or post.

export const TELEGRAM_API = "https://api.telegram.org";
export const X_API = "https://api.x.com";
export const LINK_TTL_MS = 10 * 60 * 1000;
export const APPROVAL_TTL_MS = 5 * 60 * 1000;
export const TEXT_LIMIT = 4096;
export const DEFAULT_BODY_BYTES = 4000;
export const DEFAULT_RATE = 10;
export const RATE_WINDOW_MS = 60 * 1000;
const TELEGRAM_METHODS = new Set(["getMe", "setWebhook", "sendMessage", "deleteWebhook"]);
const SECRETISH = /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|bot\d+:[A-Za-z0-9_-]{20,}|[1-9A-HJ-NP-Za-km-z]{80,}/;

export function createChannelStore() {
  return {
    links: new Map(),
    accounts: new Map(),
    secrets: new Map(),
    seen: new Map(),
    outbox: new Map(),
    approvals: new Map(),
    rates: new Map(),
    autoReply: new Map(),
  };
}

export function exportChannelState(store) {
  return JSON.stringify({
    links: [...store.links],
    accounts: [...store.accounts],
    secrets: [...store.secrets],
    seen: [...store.seen],
    outbox: [...store.outbox],
    approvals: [...store.approvals],
    rates: [...store.rates],
    autoReply: [...store.autoReply],
  });
}

export function importChannelState(raw) {
  const data = JSON.parse(raw);
  const store = createChannelStore();
  for (const key of Object.keys(store)) store[key] = new Map(data[key] || []);
  return store;
}

function statusRow(extra) {
  return {
    configured: false,
    connected: false,
    testPassed: false,
    scraping: false,
    called: false,
    ...extra,
  };
}

export function channelCatalog() {
  return [
    statusRow({
      id: "telegram",
      label: "Telegram",
      api: TELEGRAM_API,
      official: true,
      status: "not-configured",
      capabilities: ["inbound-text", "account-link", "reply-once"],
      credential: "customer-bot-token",
      sharedWithWren: false,
    }),
    statusRow({
      id: "x",
      label: "X",
      api: X_API,
      official: true,
      status: "not-configured",
      capabilities: ["oauth-dm", "oauth-post"],
      scopes: { dm: "dm.read dm.write", post: "tweet.read tweet.write" },
      credential: "customer-oauth",
      sharedWithWren: false,
      sharedWithGrok: false,
      scrape: false,
      webhookAvailable: false,
      webhookReason: "paid-tier-not-assumed",
    }),
  ];
}

export function channelRequest(id, input) {
  const row = channelCatalog().find((item) => item.id === id);
  if (!row) return { ok: false, status: 404, error: "unknown", called: false };
  return {
    ok: false,
    status: 503,
    error: "not-configured",
    id: row.id,
    api: row.api,
    capabilities: row.capabilities,
    configured: false,
    connected: false,
    testPassed: false,
    called: false,
    token: undefined,
    ignoredSecret: Boolean(input && (input.token || input.accessToken || input.apiKey)),
  };
}

export function accountStatus(store, tenantId) {
  const secretStored = store.secrets.has(`${tenantId}:telegram`) || store.secrets.has(`${tenantId}:x`);
  return channelCatalog().map((row) => ({
    ...row,
    secretStored: store.secrets.has(`${tenantId}:${row.id}`),
    configured: false,
    connected: false,
    testPassed: false,
    enabled: false,
    note: secretStored ? "secret-stored-is-not-connected" : "absent",
  }));
}

export function saveCustomerBotToken(store, { master, tenantId, token }) {
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(token || ""))) return { ok: false, reason: "token" };
  const packed = encryptSecret(master, token, tenantId);
  store.secrets.set(`${tenantId}:telegram`, packed);
  return { ok: true, secretStored: true, configured: false, connected: false, testPassed: false };
}

export function telegramMethodUrl(token, method) {
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(token || ""))) return { ok: false, reason: "token", called: false };
  if (!TELEGRAM_METHODS.has(method)) return { ok: false, reason: "method", called: false };
  if (String(token).includes("/") || String(method).includes("/")) return { ok: false, reason: "path", called: false };
  const url = new URL(`/bot${token}/${method}`, TELEGRAM_API);
  if (url.host !== "api.telegram.org" || url.protocol !== "https:") return { ok: false, reason: "host", called: false };
  return { ok: true, href: url.href, called: false };
}

export async function validateWebhookUrl(raw, resolveImpl) {
  if (typeof resolveImpl !== "function") return { ok: false, reason: "dns-required", called: false };
  const target = await assertPublicTarget(raw, resolveImpl);
  if (!target.ok) return { ok: false, reason: target.reason, called: false };
  if (target.host === "api.telegram.org" || target.host === "api.x.com") return { ok: false, reason: "platform-host", called: false };
  return { ok: true, href: target.href, host: target.host, called: false };
}

export async function planSetWebhook({ token, webhookUrl, secret, resolveImpl }) {
  const method = telegramMethodUrl(token, "setWebhook");
  const target = await validateWebhookUrl(webhookUrl, resolveImpl);
  if (!method.ok) return method;
  if (!target.ok) return target;
  if (!secret || String(secret).length < 16) return { ok: false, reason: "secret", called: false };
  return {
    ok: true,
    called: false,
    href: method.href,
    body: {
      url: target.href,
      secret_token: secret,
      allowed_updates: ["message"],
    },
  };
}

export function verifyTelegramSecret(expected, header) {
  return safeEqual(expected, header);
}

export function conversationKey({ tenantId, subjectId, channel, threadId }) {
  if (!tenantId || !subjectId || !channel || threadId == null || threadId === "") return null;
  return [tenantId, subjectId, channel, String(threadId)].join(":");
}

export function plainText(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function oneReply(text) {
  const clean = plainText(text);
  return {
    parseMode: null,
    linkTracking: false,
    maxSends: 1,
    truncated: Buffer.byteLength(clean) > TEXT_LIMIT,
    text: Buffer.from(clean).subarray(0, TEXT_LIMIT).toString("utf8"),
    called: false,
  };
}

export function issueLink(store, session, now = Date.now()) {
  if (!session || !session.tenantId || !session.subjectId) return { ok: false, reason: "auth" };
  const token = randomBytes(16).toString("hex");
  store.links.set(token, {
    tenantId: session.tenantId,
    subjectId: session.subjectId,
    exp: now + LINK_TTL_MS,
    used: false,
  });
  return { ok: true, token, exp: now + LINK_TTL_MS };
}

export function setAutoReply(store, tenantId, enabled) {
  store.autoReply.set(tenantId, enabled === true);
  return { ok: true, autoReply: enabled === true };
}

function accountKey(tenantId, platformUserId, chatId) {
  return `telegram:${tenantId}:${platformUserId}:${chatId}`;
}

function bindAccount(store, link, platformUserId, chatId) {
  const key = accountKey(link.tenantId, platformUserId, chatId);
  const account = {
    tenantId: link.tenantId,
    subjectId: link.subjectId,
    platformUserId: String(platformUserId),
    chatId: String(chatId),
    role: "member",
    groupAdmin: false,
  };
  store.accounts.set(key, account);
  return account;
}

function lookupAccount(store, platformUserId) {
  for (const account of store.accounts.values()) {
    if (account.platformUserId === String(platformUserId)) return account;
  }
  return null;
}

function remember(store, dedup, row) {
  store.seen.set(dedup, row.id);
  store.outbox.set(row.id, row);
  return { ok: true, duplicate: false, outbox: row, sent: false, called: false, providerCalled: false };
}

function rateOk(store, tenantId, platform, now, limit) {
  const key = `${tenantId}:${platform}`;
  const row = store.rates.get(key) || { start: now, count: 0 };
  if (now - row.start >= RATE_WINDOW_MS) {
    row.start = now;
    row.count = 0;
  }
  row.count += 1;
  store.rates.set(key, row);
  return row.count <= limit;
}

export function acceptTelegramUpdate(store, input, now = Date.now()) {
  const update = input.update || {};
  const botId = String(input.botId || "");
  if (!botId) return { ok: false, status: 400, reason: "bot", called: false };
  if (!verifyTelegramSecret(input.secret, input.header)) return { ok: false, status: 401, reason: "secret", called: false };
  if (!Number.isInteger(update.update_id)) return { ok: false, status: 400, reason: "update", called: false };
  const message = update.message || {};
  const fromId = message.from && message.from.id;
  const chat = message.chat || {};
  const provisional = lookupAccount(store, fromId);
  const tenantForDedup = provisional ? provisional.tenantId : `unlinked:${botId}`;
  const dedup = `${tenantForDedup}:${botId}:${update.update_id}`;
  if (store.seen.has(dedup)) {
    return {
      ok: true,
      duplicate: true,
      outbox: store.outbox.get(store.seen.get(dedup)),
      sent: false,
      called: false,
      providerCalled: false,
    };
  }
  if (Object.prototype.hasOwnProperty.call(update, "user_id") || Object.prototype.hasOwnProperty.call(message, "user_id")) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "unlinked",
      tenantId: tenantForDedup,
      taskId: null,
      sent: false,
      called: false,
      trustedBodyUser: false,
    });
  }
  const text = typeof message.text === "string" ? message.text : "";
  const start = text.match(/^\/start(?:\s+([A-Za-z0-9]+))?$/);
  if (start) {
    const link = start[1] ? store.links.get(start[1]) : null;
    const platformOk = /^\d+$/.test(String(fromId || "")) && /^-?\d+$/.test(String(chat.id ?? ""));
    if (!link || link.used || link.exp < now || !platformOk || chat.type === "group" || chat.type === "supergroup") {
      return remember(store, dedup, {
        id: `out-${update.update_id}`,
        status: "unlinked",
        tenantId: tenantForDedup,
        taskId: null,
        sent: false,
        called: false,
      });
    }
    link.used = true;
    const account = bindAccount(store, link, fromId, chat.id);
    const linkedDedup = `${account.tenantId}:${botId}:${update.update_id}`;
    return remember(store, linkedDedup, {
      id: `out-${update.update_id}`,
      status: "linked",
      tenantId: account.tenantId,
      subjectId: account.subjectId,
      taskId: null,
      role: account.role,
      groupAdmin: false,
      sent: false,
      called: false,
    });
  }
  if (!provisional) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "unlinked",
      tenantId: tenantForDedup,
      taskId: null,
      sent: false,
      called: false,
    });
  }
  const group = chat.type === "group" || chat.type === "supergroup";
  const botName = String(input.botUsername || "").toLowerCase();
  if (group && (!botName || !plainText(text).toLowerCase().includes(`@${botName}`))) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "mention-required",
      tenantId: provisional.tenantId,
      permission: "tbc",
      role: "member",
      groupAdmin: false,
      taskId: null,
      sent: false,
      called: false,
    });
  }
  if (SECRETISH.test(text)) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "refused",
      tenantId: provisional.tenantId,
      taskId: null,
      text: null,
      sent: false,
      called: false,
    });
  }
  const limit = Number(input.maxBytes || DEFAULT_BODY_BYTES);
  if (Buffer.byteLength(text) > limit) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "too-large",
      tenantId: provisional.tenantId,
      taskId: null,
      text: null,
      sent: false,
      called: false,
    });
  }
  const rateLimit = Number(input.rateLimit || DEFAULT_RATE);
  if (!rateOk(store, provisional.tenantId, "telegram", now, rateLimit)) {
    return remember(store, dedup, {
      id: `out-${update.update_id}`,
      status: "rate",
      tenantId: provisional.tenantId,
      taskId: null,
      sent: false,
      called: false,
    });
  }
  const threadId = `telegram:${chat.id}:${message.message_thread_id || "root"}`;
  const conversationId = conversationKey({
    tenantId: provisional.tenantId,
    subjectId: provisional.subjectId,
    channel: "telegram",
    threadId,
  });
  const clean = plainText(text);
  const gate = admit(
    input.tasks,
    { userId: provisional.subjectId },
    {
      capability: "view",
      app: "ai-workspace",
      text: clean,
      source: "telegram",
      conversationId,
      tool: "none",
    },
    input.policy,
    input.membership,
    now,
  );
  const replyOn = store.autoReply.get(provisional.tenantId) !== false;
  const reply = replyOn && gate.ok ? oneReply(clean) : null;
  const status = gate.ok ? "admitted" : "unconfigured";
  return remember(store, dedup, {
    id: `out-${update.update_id}`,
    status,
    tenantId: provisional.tenantId,
    subjectId: provisional.subjectId,
    conversationId,
    taskId: gate.record ? gate.record.taskId : gate.taskId || null,
    reason: gate.ok ? null : gate.reason,
    autoReply: replyOn,
    reply,
    sent: false,
    called: false,
    providerCalled: false,
    adminExecute: false,
    fetchUrl: false,
    role: "member",
    groupAdmin: false,
    permission: group ? "tbc" : "direct",
  });
}

export function xRegistry() {
  return channelCatalog().find((item) => item.id === "x");
}

export function approveXOutbound(store, { session, scope, recipientId, body, now = Date.now() }) {
  if (!session || session.owner !== true || !session.tenantId || !session.subjectId) {
    return { ok: false, reason: "owner", called: false };
  }
  if (scope !== "dm" && scope !== "post") return { ok: false, reason: "scope", called: false };
  if (!recipientId || typeof body !== "string" || !body) return { ok: false, reason: "exact", called: false };
  const id = randomBytes(16).toString("hex");
  store.approvals.set(id, {
    id,
    tenantId: session.tenantId,
    subjectId: session.subjectId,
    scope,
    recipientId: String(recipientId),
    body,
    exp: now + APPROVAL_TTL_MS,
    used: false,
    result: null,
  });
  return { ok: true, approvalId: id, exp: now + APPROVAL_TTL_MS, called: false, connected: false };
}

export function executeApprovedX(store, { approvalId, scope, recipientId, body, now = Date.now() }) {
  const row = store.approvals.get(approvalId);
  if (!row) return { ok: false, reason: "approval", called: false, connected: false };
  if (row.used) return { ok: false, idempotent: true, reason: row.result.reason, called: false, result: row.result, connected: false };
  if (row.exp < now) return { ok: false, reason: "expired", called: false, connected: false };
  if (row.scope !== scope || row.recipientId !== String(recipientId) || row.body !== body) {
    return { ok: false, reason: "mismatch", called: false, connected: false };
  }
  row.used = true;
  row.result = {
    ok: false,
    reason: "unconfigured",
    called: false,
    provider: null,
    redacted: redact(body),
  };
  return { ok: false, reason: "unconfigured", idempotent: false, called: false, connected: false, result: row.result };
}
