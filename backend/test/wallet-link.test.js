import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { generateEd25519, publicKeyFromRaw, signBytes } from "../ed25519.js";
import { encryptSecret, resolveProviderKey } from "../secretStore.js";
import { provisionMember } from "../sessions.js";
import { createFlywheelGrant, enableFlywheel, haltFlywheel, reviewSubmission } from "../flywheel-grant.js";
import { admit, createTaskCache, serverPolicy } from "../task-invocation.js";
import { canonicalLinkMessage, createWalletDesk, issueChallenge, verifyLink } from "../wallet-link.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encode58(buffer) {
  let digits = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + digits.reverse().map((digit) => ALPHABET[digit]).join("");
}

function signer() {
  const pair = generateEd25519();
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - 32);
  return { pair, pubkey: encode58(raw), raw };
}

const session = { tenantId: "tenant-a", subject: "user-a", sessionId: "sid-a" };

test("a wallet signature links one account and does not grant trade or root", async () => {
  const desk = createWalletDesk();
  assert.equal(issueChallenge(desk, session, "https://evil.example", "solflare").reason, "host");
  assert.equal(issueChallenge(desk, session, "valhalla-app.xyz", "phantom").reason, "wallet");
  const issued = issueChallenge(desk, session, "Valhalla-App.xyz", "solflare", 1_000);
  const keys = signer();
  const message = canonicalLinkMessage({
    host: issued.host,
    challengeId: issued.challengeId,
    nonce: issued.nonce,
    notBefore: issued.notBefore,
    expires: issued.expires,
    pubkey: keys.pubkey,
    sessionId: session.sessionId,
    subject: session.subject,
  });
  const signature = encode58(signBytes(keys.pair.privateKey, message));
  const linked = await verifyLink(desk, session, {
    wallet: "solflare",
    challengeId: issued.challengeId,
    publicKey: keys.pubkey,
    signature,
    message: message.toString("utf8"),
  }, 1_000);
  assert.equal(linked.ok, true);
  assert.equal(linked.trade, false);
  assert.equal(linked.owner, false);
  assert.equal(linked.execution, false);
  const again = await verifyLink(desk, session, {
    wallet: "solflare",
    challengeId: issued.challengeId,
    publicKey: keys.pubkey,
    signature,
    message: message.toString("utf8"),
  }, 1_000);
  assert.equal(again.reason, "challenge");
  const other = { tenantId: "tenant-b", subject: "user-b", sessionId: "sid-b" };
  const second = issueChallenge(desk, other, "valhalla-app.xyz", "metamask", 2_000);
  const otherMessage = canonicalLinkMessage({
    host: second.host,
    challengeId: second.challengeId,
    nonce: second.nonce,
    notBefore: second.notBefore,
    expires: second.expires,
    pubkey: keys.pubkey,
    sessionId: other.sessionId,
    subject: other.subject,
  });
  const taken = await verifyLink(desk, other, {
    wallet: "metamask",
    challengeId: second.challengeId,
    publicKey: keys.pubkey,
    signature: encode58(signBytes(keys.pair.privateKey, otherMessage)),
    message: otherMessage.toString("utf8"),
  }, 2_000);
  assert.equal(taken.reason, "wallet-taken");
  assert.equal(publicKeyFromRaw(keys.raw) != null, true);
});

test("one challenge cannot be consumed twice at the same time", async () => {
  const desk = createWalletDesk();
  const issued = issueChallenge(desk, session, "valhalla-app.xyz", "metamask", 1_000);
  const keys = signer();
  const message = canonicalLinkMessage({
    host: issued.host,
    challengeId: issued.challengeId,
    nonce: issued.nonce,
    notBefore: issued.notBefore,
    expires: issued.expires,
    pubkey: keys.pubkey,
    sessionId: session.sessionId,
    subject: session.subject,
  });
  const body = {
    wallet: "metamask",
    challengeId: issued.challengeId,
    publicKey: keys.pubkey,
    signature: encode58(signBytes(keys.pair.privateKey, message)),
    message: "tampered",
  };
  assert.equal((await verifyLink(desk, session, body, 1_000)).reason, "message");
  body.message = message.toString("utf8");
  const [left, right] = await Promise.all([
    verifyLink(desk, session, body, 1_000),
    verifyLink(desk, session, body, 1_000),
  ]);
  assert.equal([left.ok, right.ok].filter(Boolean).length, 1);
});

test("a deployment key is not BYOK and an empty packed key is rejected", () => {
  const shared = resolveProviderKey({ DEEPSEEK_API_KEY: "server-key" }, null, "tenant-a");
  assert.equal(shared.source, "deployment");
  assert.equal(resolveProviderKey({ SETUP_MASTER_KEY: "master" }, "", "tenant-a").reason, "empty");
  const packed = encryptSecret("master", "tenant-key", "tenant-a");
  const byok = resolveProviderKey({ SETUP_MASTER_KEY: "master" }, packed, "tenant-a");
  assert.equal(byok.source, "byok");
  assert.equal(byok.key, "tenant-key");
  const logged = JSON.stringify({ source: byok.source });
  assert.equal(logged.includes("tenant-key"), false);
  const store = { data: { membership: {} }, flush() {} };
  const row = provisionMember(store, "member-1");
  assert.deepEqual(row.installed, ["trading", "ai-workspace"]);
  assert.equal(row.role, "member");
  assert.equal(row.installed.includes("thalos"), false);
  assert.equal(provisionMember(store, "member-1"), row);
  const { mapTask } = createRequire(import.meta.url)("../provider/channel.cjs");
  assert.equal(mapTask({ capability: "chat" }).capability, "chat");
  assert.equal(mapTask({ text: "hello" }).capability, null);
});

test("flywheel stays advisory and a wallet link is not authority", () => {
  const grant = createFlywheelGrant({ tenantId: "tenant-a", subject: "user-a", seed: "do-not-store" });
  assert.equal(grant.execution, false);
  assert.equal(grant.status, "disabled");
  assert.equal(grant.agentId, "flywheel");
  assert.equal(grant.supervisor, "zeus");
  assert.equal(grant.seedAccess, false);
  assert.equal(JSON.stringify(grant).includes("do-not-store"), false);
  assert.equal(enableFlywheel(grant, { owner: true }).reason, "owner-cannot-enable");
  assert.equal(grant.execution, false);
  const reviewed = reviewSubmission(grant, { instructions: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }] });
  assert.equal(reviewed.executed, false);
  assert.equal(reviewed.reason, "delegated-execution-unavailable");
  assert.equal(haltFlywheel(grant, "customerCancelled").revocationVersion, 2);
});

test("task text is hashed in full bytes and a longer suffix is not a replay", () => {
  const cache = createTaskCache();
  const member = { userId: "user-a", owner: false };
  const policy = serverPolicy(member, { VALHALLA_LOCAL_RELAY: "1" });
  const seat = { installed: ["ai-workspace"], role: "member" };
  const left = admit(cache, member, {
    capability: "view",
    app: "ai-workspace",
    text: `${"a".repeat(7999)}x`,
    conversationId: "c1",
  }, policy, seat);
  const right = admit(cache, member, {
    capability: "view",
    app: "ai-workspace",
    text: `${"a".repeat(7999)}y`,
    conversationId: "c1",
  }, policy, seat);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.notEqual(left.record.taskId, right.record.taskId);
  const long = admit(cache, member, {
    capability: "view",
    app: "ai-workspace",
    text: "a".repeat(8001),
    conversationId: "c1",
  }, policy, seat);
  assert.equal(long.reason, "text_too_long");
});
