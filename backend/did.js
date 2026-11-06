import { randomBytes } from "node:crypto";
import { classifyUrl } from "./ssrf.js";
import { publicKeyFromRaw, signBytes, verifyBytes } from "./ed25519.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_PREFIX = Buffer.from([0xed, 0x01]);

function encodeBase58(buffer) {
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

function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 80) return null;
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

export function emailBridge() {
  return {
    authMode: "email",
    identityProvider: "email",
    did: null,
    custodial: false,
    decentralizedIdentity: "unavailable",
  };
}

export function didKeyFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) return null;
  return `did:key:z${encodeBase58(Buffer.concat([ED25519_PREFIX, raw]))}`;
}

export function parseDidKey(value) {
  if (typeof value !== "string" || !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  const decoded = decodeBase58(value.slice("did:key:z".length));
  if (!decoded || decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
  return { did: value, raw: decoded.subarray(2) };
}

export function didDocument(did) {
  const parsed = parseDidKey(did);
  if (!parsed) return null;
  const multibase = did.slice("did:key:".length);
  const method = `${did}#${multibase}`;
  return {
    id: did,
    verificationMethod: [{
      id: method,
      type: "Ed25519VerificationKey2020",
      controller: did,
      publicKeyMultibase: multibase,
    }],
    authentication: [method],
  };
}

export function issueDidChallenge({ domain, uri, now = Date.now() }) {
  const host = String(domain || "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || host.includes("localhost") || host.endsWith(".local")) {
    return { ok: false, reason: "domain" };
  }
  const target = classifyUrl(uri);
  if (!target.ok || target.host !== host) return { ok: false, reason: target.ok ? "domain" : target.reason };
  return {
    ok: true,
    domain: host,
    nonce: randomBytes(16).toString("hex"),
    uri: target.url.href,
    issuedAt: now,
    exp: now + 5 * 60 * 1000,
    chain: "key",
  };
}

function proofMessage(challenge, did) {
  return Buffer.from([
    challenge.domain,
    challenge.nonce,
    challenge.uri,
    String(challenge.issuedAt),
    String(challenge.exp),
    challenge.chain,
    did,
  ].join("\n"));
}

export function signDidProof(privateKey, challenge, did) {
  return signBytes(privateKey, proofMessage(challenge, did)).toString("base64");
}

export function verifyDidProof({ challenge, did, document, proof, now = Date.now() }) {
  const parsed = parseDidKey(did);
  if (!parsed || !challenge || challenge.chain !== "key") return { ok: false, reason: "did" };
  if (challenge.domain !== new URL(challenge.uri).host) return { ok: false, reason: "domain" };
  if (!Number.isFinite(challenge.issuedAt) || !Number.isFinite(challenge.exp)) return { ok: false, reason: "time" };
  if (challenge.issuedAt > now || challenge.exp < now || challenge.exp - challenge.issuedAt > 10 * 60 * 1000) {
    return { ok: false, reason: "time" };
  }
  if (!/^[0-9a-f]{32}$/.test(String(challenge.nonce || ""))) return { ok: false, reason: "nonce" };
  if (classifyUrl(challenge.uri).ok !== true) return { ok: false, reason: "uri" };
  if (!document || document.id !== did || !Array.isArray(document.verificationMethod)) return { ok: false, reason: "document" };
  const urls = JSON.stringify(document).match(/https?:\/\/[^"\\]+/g) || [];
  if (urls.some((url) => classifyUrl(url).ok !== true)) return { ok: false, reason: "document" };
  const methodId = document.authentication && document.authentication[0];
  const method = document.verificationMethod.find((item) => item && item.id === methodId);
  if (!method || method.controller !== did || method.type !== "Ed25519VerificationKey2020") return { ok: false, reason: "document" };
  if (method.publicKeyMultibase !== did.slice("did:key:".length)) return { ok: false, reason: "document" };
  if (JSON.stringify(document).includes("http://") || JSON.stringify(document).includes("localhost")) return { ok: false, reason: "document" };
  const key = publicKeyFromRaw(parsed.raw);
  const signature = Buffer.from(String(proof || ""), "base64");
  if (!key || signature.length !== 64 || !verifyBytes(key, proofMessage(challenge, did), signature)) {
    return { ok: false, reason: "proof" };
  }
  return {
    ok: true,
    verifiedDid: did,
    linked: false,
    ...emailBridge(),
  };
}
