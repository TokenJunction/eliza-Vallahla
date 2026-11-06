import { randomBytes } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT, jwtVerify } from "jose";
import { LIMITS, NAME_ID } from "./relayState.js";

export const RELAY_AUD = "valhalla-device-relay";
export const RELAY_PURPOSE = "device-relay";
export const DEFAULT_ISSUER = "https://eliza-valhalla.onrender.com";

const HEADER_KEYS = new Set(["alg", "kid", "typ"]);
const CLAIM_KEYS = new Set([
  "iss",
  "aud",
  "purpose",
  "exp",
  "iat",
  "jti",
  "tenantId",
  "deviceId",
  "role",
  "models",
]);

const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function modelAllowed(name) {
  return typeof name === "string" && name.length <= 128 && MODEL_NAME.test(name) && !name.includes("/");
}

export async function generateRelayKey(kid = "relay-1") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "EdDSA";
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  return { kid, publicKey, privateKey, publicJwk };
}

function normalizeModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 8) return null;
  const unique = [];
  for (const name of models) {
    if (!modelAllowed(name) || unique.includes(name)) return null;
    unique.push(name);
  }
  return unique;
}

export async function issueDeviceGrant(deps, request = {}) {
  if (!deps || typeof deps.lookupAccount !== "function" || typeof deps.verifyOwner !== "function" || !deps.key) {
    return { ok: false, reason: "owner-verifier-required" };
  }
  const tenantId = request.tenantId;
  const deviceId = request.deviceId;
  if (!NAME_ID.test(String(tenantId || "")) || !NAME_ID.test(String(deviceId || ""))) {
    return { ok: false, reason: "mapping-required" };
  }
  const account = await deps.lookupAccount({ tenantId, deviceId });
  if (!account || account.ok !== true || account.tenantId !== tenantId || account.deviceId !== deviceId) {
    return { ok: false, reason: "account-unmapped" };
  }
  const owner = await deps.verifyOwner({ tenantId, deviceId, account });
  if (!owner || owner.ok !== true) return { ok: false, reason: "owner-verification-failed" };
  const role = account.role === "owner" || account.role === "customer" ? account.role : "";
  if (!role) return { ok: false, reason: "role-unknown" };
  if (request.register === true) {
    if (role !== "owner") return { ok: false, reason: "owner-register-only" };
    if (typeof deps.registerDevice !== "function") return { ok: false, reason: "owner-register-api-required" };
    const saved = await deps.registerDevice({ tenantId, deviceId, role: "owner" });
    if (!saved || saved.ok !== true || saved.tenantId !== tenantId || saved.deviceId !== deviceId) {
      return { ok: false, reason: "device-not-registered" };
    }
  }
  const models = normalizeModels(request.models);
  if (!models) return { ok: false, reason: "model-list-required" };
  const nowMs = Number.isFinite(request.now) ? request.now : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + LIMITS.grantTtlSeconds;
  const jti = randomBytes(16).toString("base64url");
  const token = await new SignJWT({
    purpose: RELAY_PURPOSE,
    tenantId,
    deviceId,
    role,
    models,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: deps.key.kid, typ: "JWT" })
    .setIssuer(deps.issuer || DEFAULT_ISSUER)
    .setAudience(RELAY_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(deps.key.privateKey);
  return {
    ok: true,
    token,
    jti,
    exp: exp * 1000,
    tenantId,
    deviceId,
    role,
    models,
  };
}

function headerAllowed(header) {
  if (!header || header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string") return false;
  return Object.keys(header).every((key) => HEADER_KEYS.has(key));
}

export async function verifyDeviceGrant(token, options = {}) {
  if (typeof token !== "string" || Buffer.byteLength(token) > 8192) return { ok: false, reason: "token-rejected" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, reason: "token-rejected" };
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "token-rejected" };
  }
  if (!headerAllowed(header)) return { ok: false, reason: "header-rejected" };
  if (!options.key || header.kid !== options.key.kid) return { ok: false, reason: "kid-rejected" };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  let verified;
  try {
    verified = await jwtVerify(token, options.key.publicKey, {
      algorithms: ["EdDSA"],
      issuer: options.issuer || DEFAULT_ISSUER,
      audience: RELAY_AUD,
      clockTolerance: 0,
      currentDate: new Date(nowMs),
    });
  } catch (error) {
    const code = error && error.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && /iat/.test(String(error.claim || error.message))) {
      return { ok: false, reason: "iat-required" };
    }
    return { ok: false, reason: "signature-rejected" };
  }
  const payload = verified.payload;
  if (!payload || Object.keys(payload).some((key) => !CLAIM_KEYS.has(key))) {
    return { ok: false, reason: "claim-rejected" };
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || typeof payload.jti !== "string") {
    return { ok: false, reason: "iat-required" };
  }
  if (payload.exp - payload.iat !== LIMITS.grantTtlSeconds) return { ok: false, reason: "ttl-rejected" };
  if (payload.purpose !== RELAY_PURPOSE) return { ok: false, reason: "purpose-rejected" };
  if (payload.role !== "owner" && payload.role !== "customer") return { ok: false, reason: "role-rejected" };
  if (!NAME_ID.test(String(payload.tenantId || "")) || !NAME_ID.test(String(payload.deviceId || ""))) {
    return { ok: false, reason: "mapping-rejected" };
  }
  const models = normalizeModels(payload.models);
  if (!models) return { ok: false, reason: "model-rejected" };
  const unread = decodeJwt(token);
  if (unread.jti !== payload.jti) return { ok: false, reason: "claim-rejected" };
  return {
    ok: true,
    jti: payload.jti,
    exp: payload.exp * 1000,
    iat: payload.iat * 1000,
    tenantId: payload.tenantId,
    deviceId: payload.deviceId,
    role: payload.role,
    models,
  };
}

export function costReceiptOk(receipt, task) {
  if (!receipt || receipt.allocator !== "wren" || receipt.allocated !== true) return false;
  if (!task || receipt.taskId !== task.taskId || receipt.tenantId !== task.tenantId) return false;
  return typeof receipt.amountUsd === "number" && Number.isFinite(receipt.amountUsd) && receipt.amountUsd >= 0;
}
