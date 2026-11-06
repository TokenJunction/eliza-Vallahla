import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptLive } from "../workers/live-session.mjs";

export function emailHash(email) {
  return createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
}

function blank() {
  return { adminEmail: null, users: {}, sessions: {}, preferences: {}, terms: {}, notes: {}, membership: {}, tasks: {}, conversations: {} };
}

export function openStore(dir) {
  const data = blank();
  let file = null;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    file = join(dir, "store.json");
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") Object.assign(data, { ...blank(), ...parsed });
    } catch {
      // A new directory has no store yet. The first flush creates it.
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  }
  function flush() {
    if (!file) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  }
  return { durable: Boolean(dir), data, flush };
}

export function tenantFor(store, email) {
  const eh = emailHash(email);
  if (!store.data.users[eh]) {
    store.data.users[eh] = {
      userId: randomUUID(),
      eh,
      email: String(email || "").trim().toLowerCase(),
    };
    store.flush();
  }
  return store.data.users[eh];
}

export function provisionMember(store, userId) {
  if (!userId) return null;
  if (!store.data.membership) store.data.membership = {};
  if (store.data.membership[userId]) return store.data.membership[userId];
  store.data.membership[userId] = {
    installed: ["trading", "ai-workspace"],
    role: "member",
    entitlement: "preview",
  };
  store.flush();
  return store.data.membership[userId];
}

export function claimAdmin(store, email, configured) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  if (configured && normalized !== String(configured).trim().toLowerCase()) return null;
  if (store.data.adminEmail && store.data.adminEmail !== normalized) return null;
  store.data.adminEmail = normalized;
  const tenant = tenantFor(store, normalized);
  store.data.membership[tenant.userId] = {
    installed: ["trading", "ai-workspace", "thalos", "data-explorer"],
    role: "owner",
  };
  store.flush();
  return tenant;
}

export function issueBoundSession(store, { email, userId, did = null, code = true, google = false }) {
  const sid = randomBytes(32).toString("base64url");
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const record = {
    sid,
    ver: 1,
    eh: emailHash(email),
    did: did || null,
    exp,
    code: code === true,
    google: google === true,
    revoked: false,
    email: String(email || "").trim().toLowerCase(),
    userId,
  };
  store.data.sessions[sid] = record;
  store.flush();
  return { token: sid, record };
}

export function verifyBoundSession(store, token, now = Date.now()) {
  if (!token || String(token).includes(".")) return null;
  const record = store.data.sessions[token];
  if (!record) return null;
  const live = acceptLive(record, {
    sid: record.sid,
    ver: record.ver,
    eh: record.eh,
    did: record.did,
    exp: record.exp,
  }, now);
  if (!live) return null;
  return record;
}

export function revokeBoundSession(store, sid) {
  const record = store.data.sessions[sid];
  if (!record) return false;
  record.revoked = true;
  store.flush();
  return true;
}

export function cleanDisplayName(value) {
  const text = String(value || "").replace(/[<>&]/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 1 || text.length > 80) return null;
  return text;
}
