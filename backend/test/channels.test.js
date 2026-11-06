import assert from "node:assert/strict";
import test from "node:test";
import { connectorRequest, listConnectors } from "../connectors.js";
import { createTaskCache } from "../task-invocation.js";
import { decryptSecret } from "../secretStore.js";
import {
  acceptTelegramUpdate,
  accountStatus,
  approveXOutbound,
  channelCatalog,
  conversationKey,
  createChannelStore,
  executeApprovedX,
  exportChannelState,
  importChannelState,
  issueLink,
  planSetWebhook,
  plainText,
  saveCustomerBotToken,
  setAutoReply,
  telegramMethodUrl,
  validateWebhookUrl,
  verifyTelegramSecret,
  xRegistry,
} from "../channels.js";

const secret = "webhook-secret-value";
const botToken = "123456:AAHexampleTokenValueForTests00";
const session = { tenantId: "tenant-a", subjectId: "subject-a" };
const policy = { localRelay: true, allowCloud: false, remainingUsd: 0, cloudEstimateUsd: 0.01, models: [], production: false, durable: false };
const membership = { installed: ["ai-workspace"], role: "member" };

function update(id, text, extra = {}) {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      from: { id: 42, is_bot: false, ...(extra.from || {}) },
      chat: { id: 42, type: "private", ...(extra.chat || {}) },
      ...extra.message,
    },
    ...extra.update,
  };
}

function inbound(store, id, text, extra = {}) {
  return acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    botUsername: "valhalla_bot",
    update: update(id, text, extra),
    tasks: extra.tasks || createTaskCache(),
    policy,
    membership,
    maxBytes: extra.maxBytes,
    rateLimit: extra.rateLimit,
  });
}

function linkedStore() {
  const store = createChannelStore();
  const tasks = createTaskCache();
  const link = issueLink(store, session, 1_000);
  const started = acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    update: update(1, `/start ${link.token}`),
    tasks,
    policy,
    membership,
  }, 1_000);
  assert.equal(started.outbox.status, "linked");
  assert.equal(started.outbox.role, "member");
  return { store, tasks };
}

test("catalog stays disconnected and does not reuse another connector", () => {
  const rows = channelCatalog();
  assert.equal(rows.every((row) => row.configured === false && row.connected === false && row.testPassed === false), true);
  assert.equal(rows.find((row) => row.id === "x").sharedWithGrok, false);
  assert.equal(rows.find((row) => row.id === "x").sharedWithWren, false);
  assert.equal(rows.find((row) => row.id === "x").scrape, false);
  assert.equal(rows.find((row) => row.id === "x").webhookAvailable, false);
  assert.notEqual(rows.find((row) => row.id === "x").scopes.dm, rows.find((row) => row.id === "x").scopes.post);
  assert.equal(listConnectors().every((row) => row.configured === false && row.connected === false && row.scraping === false), true);
  const posted = connectorRequest("x", { accessToken: "customer-secret-value" });
  assert.equal(posted.called, false);
  assert.equal(posted.connected, false);
  assert.equal(JSON.stringify(posted).includes("customer-secret-value"), false);
  assert.equal(xRegistry().connected, false);
});

test("a saved bot token stays encrypted and unconnected", () => {
  const store = createChannelStore();
  const saved = saveCustomerBotToken(store, { master: "master-key", tenantId: "tenant-a", token: botToken });
  assert.equal(saved.configured, false);
  assert.equal(saved.connected, false);
  assert.equal(saved.testPassed, false);
  const status = accountStatus(store, "tenant-a").find((row) => row.id === "telegram");
  assert.equal(status.secretStored, true);
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.enabled, false);
  assert.equal(JSON.stringify(status).includes(botToken), false);
  assert.equal(decryptSecret("master-key", store.secrets.get("tenant-a:telegram"), "tenant-a"), botToken);
});

test("telegram calls use the official host and a public webhook", async () => {
  const method = telegramMethodUrl(botToken, "sendMessage");
  const resolveImpl = async (host) => host.endsWith(".example") ? ["203.0.113.10"] : ["127.0.0.1"];
  assert.equal(method.called, false);
  assert.equal(method.href.startsWith("https://api.telegram.org/bot"), true);
  assert.equal(method.href.endsWith("/sendMessage"), true);
  assert.equal(telegramMethodUrl(botToken, "getUpdates").ok, false);
  assert.equal((await validateWebhookUrl("http://127.0.0.1/hook", resolveImpl)).ok, false);
  assert.equal((await validateWebhookUrl("https://api.telegram.org/hook", resolveImpl)).ok, false);
  assert.equal((await validateWebhookUrl("https://hooks.internal.example/telegram", async () => ["127.0.0.1"])).ok, false);
  assert.equal((await validateWebhookUrl("https://hooks.customer.example/telegram")).reason, "dns-required");
  assert.equal((await validateWebhookUrl("https://hooks.customer.example/telegram", resolveImpl)).ok, true);
  const plan = await planSetWebhook({
    token: botToken,
    webhookUrl: "https://hooks.customer.example/telegram",
    secret,
    resolveImpl,
  });
  assert.equal(plan.called, false);
  assert.equal(plan.body.secret_token, secret);
  assert.equal(plan.body.allowed_updates.length, 1);
  assert.equal(verifyTelegramSecret(secret, secret), true);
  assert.equal(verifyTelegramSecret(secret, "webhook-secret-other"), false);
});

test("a start code binds telegram ids only for the signed-in holder", () => {
  const store = createChannelStore();
  const tasks = createTaskCache();
  assert.equal(issueLink(store, null).reason, "auth");
  const link = issueLink(store, session, 1_000);
  const raw = inbound(store, 9, "hello", { tasks });
  assert.equal(raw.outbox.status, "unlinked");
  assert.equal(raw.outbox.taskId, null);
  const forged = acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    update: { update_id: 10, user_id: session.subjectId, message: update(10, "hello").message },
    tasks,
    policy,
    membership,
  }, 1_000);
  assert.equal(forged.outbox.trustedBodyUser, false);
  assert.equal(forged.outbox.taskId, null);
  const late = acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    update: update(11, `/start ${link.token}`),
    tasks,
    policy,
    membership,
  }, 1_000 + 11 * 60 * 1000);
  assert.equal(late.outbox.status, "unlinked");
  const fresh = issueLink(store, session, 2_000);
  const bound = acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    update: update(12, `/start ${fresh.token}`),
    tasks,
    policy,
    membership,
  }, 2_000);
  assert.equal(bound.outbox.status, "linked");
  assert.equal(bound.outbox.subjectId, session.subjectId);
  const again = acceptTelegramUpdate(store, {
    secret,
    header: secret,
    botId: "bot-1",
    update: update(13, `/start ${fresh.token}`),
    tasks,
    policy,
    membership,
  }, 2_000);
  assert.equal(again.outbox.status, "unlinked");
  assert.equal(tasks.byId.size, 0);
});

test("a linked message admits one task and a retry does not admit another", () => {
  const { store, tasks } = linkedStore();
  const first = inbound(store, 20, "<b>hello</b> https://evil.example/admin", { tasks });
  assert.equal(first.outbox.status, "admitted");
  assert.equal(first.providerCalled, false);
  assert.equal(first.called, false);
  assert.equal(first.outbox.fetchUrl, false);
  assert.equal(first.outbox.adminExecute, false);
  assert.equal(first.outbox.reply.maxSends, 1);
  assert.equal(first.outbox.reply.called, false);
  assert.equal(first.outbox.reply.parseMode, null);
  assert.equal(first.outbox.reply.text.includes("<b>"), false);
  assert.equal(tasks.byId.size, 1);
  const key = conversationKey({
    tenantId: "tenant-a",
    subjectId: "subject-a",
    channel: "telegram",
    threadId: "telegram:42:root",
  });
  assert.equal(first.outbox.conversationId, key);
  const retry = inbound(store, 20, "<b>hello</b> https://evil.example/admin", { tasks });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.outbox.taskId, first.outbox.taskId);
  assert.equal(tasks.byId.size, 1);
  const reloaded = importChannelState(exportChannelState(store));
  const after = inbound(reloaded, 20, "hello", { tasks });
  assert.equal(after.duplicate, true);
  assert.equal(tasks.byId.size, 1);
});

test("group chats do not inherit admin and need a mention", () => {
  const { store, tasks } = linkedStore();
  const silent = inbound(store, 30, "hello", {
    tasks,
    chat: { id: -100, type: "group" },
    from: { is_admin: true },
  });
  assert.equal(silent.outbox.status, "mention-required");
  assert.equal(silent.outbox.groupAdmin, false);
  assert.equal(silent.outbox.role, "member");
  assert.equal(silent.outbox.permission, "tbc");
  assert.equal(tasks.byId.size, 0);
  const mentioned = inbound(store, 31, "@valhalla_bot status", {
    tasks,
    chat: { id: -100, type: "group" },
  });
  assert.equal(mentioned.outbox.status, "admitted");
  assert.equal(mentioned.outbox.groupAdmin, false);
  assert.equal(mentioned.outbox.permission, "tbc");
});

test("secrets, size, rate, and auto-reply stay inside the server plan", () => {
  const { store, tasks } = linkedStore();
  const leaked = inbound(store, 40, "sk-liveSecretValue", { tasks });
  assert.equal(leaked.outbox.status, "refused");
  assert.equal(leaked.outbox.text, null);
  const huge = inbound(store, 41, "hello!!", { tasks, maxBytes: 4 });
  assert.equal(huge.outbox.status, "too-large");
  const limited = createChannelStore();
  const link = issueLink(limited, session, 1_000);
  acceptTelegramUpdate(limited, {
    secret, header: secret, botId: "bot-1", tasks, policy, membership,
    update: update(42, `/start ${link.token}`),
  }, 1_000);
  const one = inbound(limited, 43, "one", { tasks, rateLimit: 1 });
  const two = inbound(limited, 44, "two", { tasks, rateLimit: 1 });
  assert.equal(one.outbox.status, "admitted");
  assert.equal(two.outbox.status, "rate");
  setAutoReply(store, "tenant-a", false);
  const held = inbound(store, 45, "plain", { tasks });
  assert.equal(held.outbox.status, "admitted");
  assert.equal(held.outbox.autoReply, false);
  assert.equal(held.outbox.reply, null);
  assert.equal(held.called, false);
});

test("a bad webhook secret does not open a task", () => {
  const { store, tasks } = linkedStore();
  const denied = acceptTelegramUpdate(store, {
    secret,
    header: "other-webhook-secret",
    botId: "bot-1",
    update: update(50, "hello"),
    tasks,
    policy,
    membership,
  });
  assert.equal(denied.status, 401);
  assert.equal(tasks.byId.size, 0);
});

test("an unavailable model is unconfigured and is not called twice", () => {
  const { store, tasks } = linkedStore();
  const blocked = { ...policy, localRelay: false, allowCloud: false };
  const first = acceptTelegramUpdate(store, {
    secret, header: secret, botId: "bot-1", botUsername: "valhalla_bot",
    update: update(60, "hello"),
    tasks, policy: blocked, membership,
  });
  assert.equal(first.outbox.status, "unconfigured");
  assert.equal(first.providerCalled, false);
  assert.equal(tasks.byId.size, 0);
  const second = acceptTelegramUpdate(store, {
    secret, header: secret, botId: "bot-1",
    update: update(60, "hello"),
    tasks, policy: blocked, membership,
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.outbox.status, "unconfigured");
  assert.equal(tasks.byId.size, 0);
});

test("x send stays unconfigured until an exact owner approval and still does not call", () => {
  const store = createChannelStore();
  const denied = approveXOutbound(store, { session, scope: "post", recipientId: "acct", body: "hello", now: 5_000 });
  assert.equal(denied.reason, "owner");
  const owner = { ...session, owner: true };
  const post = approveXOutbound(store, { session: owner, scope: "post", recipientId: "acct", body: "quote sk-abcdef123456", now: 5_000 });
  const dm = approveXOutbound(store, { session: owner, scope: "dm", recipientId: "acct", body: "dm", now: 5_000 });
  assert.notEqual(post.approvalId, dm.approvalId);
  const mismatch = executeApprovedX(store, { approvalId: post.approvalId, scope: "dm", recipientId: "acct", body: "quote sk-abcdef123456", now: 5_000 });
  assert.equal(mismatch.reason, "mismatch");
  assert.equal(mismatch.called, false);
  const sent = executeApprovedX(store, { approvalId: post.approvalId, scope: "post", recipientId: "acct", body: "quote sk-abcdef123456", now: 5_000 });
  assert.equal(sent.reason, "unconfigured");
  assert.equal(sent.called, false);
  assert.equal(sent.connected, false);
  assert.equal(JSON.stringify(sent.result).includes("sk-abcdef123456"), false);
  const retry = executeApprovedX(store, { approvalId: post.approvalId, scope: "post", recipientId: "acct", body: "quote sk-abcdef123456", now: 5_000 });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.called, false);
  const expired = executeApprovedX(store, { approvalId: dm.approvalId, scope: "dm", recipientId: "acct", body: "dm", now: 5_000 + 6 * 60 * 1000 });
  assert.equal(expired.reason, "expired");
  assert.equal(plainText("<a href='https://track.example'>hi</a>"), "hi");
});
