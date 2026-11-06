import { randomBytes } from "node:crypto";
import { decodeBase58, publicKeyFromRaw, verifyBytes } from "./ed25519.js";

const WALLETS = new Set(["solflare", "metamask"]);
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT = 5;

function decode58(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 90) return null;
  const bytes = [0];
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i];
  return out;
}

export function canonicalLinkMessage(fields) {
  const lines = [
    "valhalla-wallet-link",
    `host=${fields.host}`,
    `challenge=${fields.challengeId}`,
    `nonce=${fields.nonce}`,
    `notBefore=${fields.notBefore}`,
    `expires=${fields.expires}`,
    `pubkey=${fields.pubkey}`,
    `session=${fields.sessionId}`,
    `subject=${fields.subject}`,
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

export function createWalletDesk() {
  let chain = Promise.resolve();
  const challenges = new Map();
  const byAccount = new Map();
  const byPubkey = new Map();
  const rates = new Map();
  function run(fn) {
    const job = chain.then(fn, fn);
    chain = job.then(() => undefined, () => undefined);
    return job;
  }
  return { challenges, byAccount, byPubkey, rates, run };
}

function accountKey(tenantId, subject) {
  return `${tenantId}\n${subject}`;
}

export function issueChallenge(desk, session, host, wallet, now = Date.now()) {
  if (!session || !session.tenantId || !session.subject || !session.sessionId) return { ok: false, reason: "auth" };
  const domain = String(host || "").trim().toLowerCase();
  if (!domain || domain.includes("://") || domain.includes("/") || domain.includes("@")) return { ok: false, reason: "host" };
  if (!WALLETS.has(wallet)) return { ok: false, reason: "wallet" };
  const bucket = desk.rates.get(session.subject) || { start: now, count: 0 };
  if (now - bucket.start >= 60_000) {
    bucket.start = now;
    bucket.count = 0;
  }
  if (bucket.count >= RATE_LIMIT) return { ok: false, reason: "rate" };
  bucket.count += 1;
  desk.rates.set(session.subject, bucket);
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const notBefore = new Date(now).toISOString();
  const expires = new Date(now + CHALLENGE_TTL_MS).toISOString();
  const record = {
    challengeId,
    nonce,
    host: domain,
    notBefore,
    expires,
    exp: now + CHALLENGE_TTL_MS,
    tenantId: session.tenantId,
    subject: session.subject,
    sessionId: session.sessionId,
    wallet,
    used: false,
  };
  desk.challenges.set(challengeId, record);
  return {
    ok: true,
    challengeId,
    nonce,
    host: domain,
    notBefore,
    expires,
    wallet,
    trade: false,
    owner: false,
  };
}

export function verifyLink(desk, session, body, now = Date.now()) {
  return desk.run(() => {
    if (!session || !session.tenantId || !session.subject || !session.sessionId) return { ok: false, reason: "auth", trade: false, owner: false };
    if (!WALLETS.has(body.wallet)) return { ok: false, reason: "wallet", trade: false, owner: false };
    const row = desk.challenges.get(String(body.challengeId || ""));
    if (!row || row.used || row.exp < now) return { ok: false, reason: "challenge", trade: false, owner: false };
    if (row.tenantId !== session.tenantId || row.subject !== session.subject || row.sessionId !== session.sessionId) {
      return { ok: false, reason: "session", trade: false, owner: false };
    }
    if (row.wallet !== body.wallet) return { ok: false, reason: "wallet", trade: false, owner: false };
    const pubkey = String(body.publicKey || "");
    const raw = decodeBase58(pubkey);
    if (!raw) return { ok: false, reason: "pubkey", trade: false, owner: false };
    const message = canonicalLinkMessage({
      host: row.host,
      challengeId: row.challengeId,
      nonce: row.nonce,
      notBefore: row.notBefore,
      expires: row.expires,
      pubkey,
      sessionId: row.sessionId,
      subject: row.subject,
    });
    if (body.message != null && !message.equals(Buffer.from(String(body.message), "utf8"))) {
      return { ok: false, reason: "message", trade: false, owner: false };
    }
    const signature = decode58(String(body.signature || ""));
    const key = publicKeyFromRaw(raw);
    if (!signature || signature.length !== 64 || !key || !verifyBytes(key, message, signature)) {
      return { ok: false, reason: "signature", trade: false, owner: false };
    }
    const existing = desk.byPubkey.get(pubkey);
    if (existing && (existing.tenantId !== session.tenantId || existing.subject !== session.subject)) {
      return { ok: false, reason: "wallet-taken", trade: false, owner: false };
    }
    row.used = true;
    const link = { tenantId: session.tenantId, subject: session.subject, pubkey, wallet: row.wallet, trade: false, owner: false };
    desk.byAccount.set(accountKey(session.tenantId, session.subject), link);
    desk.byPubkey.set(pubkey, link);
    return { ok: true, linked: true, wallet: row.wallet, pubkey, trade: false, owner: false, execution: false };
  });
}

export function walletFor(desk, tenantId, subject) {
  return desk.byAccount.get(accountKey(tenantId, subject)) || null;
}
