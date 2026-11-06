// Browser MPC config checks. This file does not open a network connection.

const encoder = new TextEncoder();

export const MPC_PACKAGE = "@web3auth/mpc-core-kit";
export const MPC_VERSION = "3.6.0";
export const DKLS_PACKAGE = "@toruslabs/tss-dkls-lib";
export const FROST_PACKAGE = "@toruslabs/tss-frost-lib";
export const TSS_EXPORT = "tssLib";

export const NETWORKS = Object.freeze([
  "mainnet",
  "testnet",
  "cyan",
  "aqua",
  "sapphire_mainnet",
  "sapphire_devnet",
]);

const CURVE_FOR_CHAIN = Object.freeze({
  solana: "ed25519",
  ethereum: "secp256k1",
  evm: "secp256k1",
});

const TSS_FOR_CURVE = Object.freeze({
  secp256k1: DKLS_PACKAGE,
  ed25519: FROST_PACKAGE,
});

const SECRET_FIELDS = Object.freeze([
  "privateKey",
  "seed",
  "mnemonic",
  "factorKey",
  "aaPrivateKey",
  "manualSecurityFactor",
]);

const SECRET_JSON_KEYS = new Set([
  "factorKey",
  "privateKey",
  "privKey",
  "seed",
  "mnemonic",
  "aaPrivateKey",
  "mpcKey",
]);

export function utf8Size(value) {
  if (typeof value !== "string") return -1;
  return encoder.encode(value).length;
}

export function unavailable(reason) {
  return {
    available: false,
    mode: "mpc",
    live: false,
    did: null,
    root: false,
    reason,
  };
}

function badField(options) {
  if (!options || typeof options !== "object") return false;
  return SECRET_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(options, key));
}

function oversized(value, depth) {
  if (depth > 4 || value == null) return false;
  if (typeof value === "string") return utf8Size(value) > 10240;
  if (typeof value !== "object") return false;
  if (typeof value.getItem === "function") return false;
  if (Array.isArray(value)) return value.some((item) => oversized(item, depth + 1));
  return Object.keys(value).some((key) => key !== "storage" && oversized(value[key], depth + 1));
}

export function selectTss(chain, curve) {
  const expected = CURVE_FOR_CHAIN[chain];
  if (!expected || !TSS_FOR_CURVE[curve] || expected !== curve) return null;
  return {
    chain,
    curve,
    packageName: TSS_FOR_CURVE[curve],
    exportName: TSS_EXPORT,
  };
}

export function ownershipKey(claims) {
  if (!claims || typeof claims.sub !== "string" || typeof claims.iss !== "string") return null;
  if (!claims.sub || claims.sub.length > 256 || !claims.iss || claims.iss.length > 512) return null;
  return `${claims.iss}\n${claims.sub}`;
}

function decodeBase64Url(segment) {
  const base = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base.length % 4 === 0 ? base : base + "=".repeat(4 - (base.length % 4));
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function readOidcPayload(idToken) {
  if (typeof idToken !== "string" || utf8Size(idToken) > 4096 || utf8Size(idToken) < 8) {
    return { ok: false, reason: "short-jwt required" };
  }
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: "short-jwt required" };
  }
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return { ok: false, reason: "short-jwt required" };
  }
  if (!header || header.alg == null || String(header.alg).toLowerCase() === "none") {
    return { ok: false, reason: "short-jwt required" };
  }
  const key = ownershipKey(payload);
  if (!key) return { ok: false, reason: "stable-subject required" };
  return {
    ok: true,
    sub: payload.sub,
    iss: payload.iss,
    ownership: key,
    emailVerified: payload.email_verified === true,
  };
}

function storageReady(storage) {
  return Boolean(
    storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function",
  );
}

export function assessIdentityConfig(options) {
  const missing = [];
  if (!options || options.enterprise !== true) missing.push("enterprise");
  if (!options || typeof options.web3AuthClientId !== "string" || options.web3AuthClientId.length < 8) {
    missing.push("web3AuthClientId");
  }
  if (!options || !NETWORKS.includes(options.web3AuthNetwork)) missing.push("web3AuthNetwork");
  if (!options || typeof options.verifier !== "string" || options.verifier.length < 1 || options.verifier.length > 256) {
    missing.push("verifier");
  }
  if (!options || typeof options.manualSync !== "boolean") missing.push("manualSync");
  if (!options || (options.uxMode !== "popup" && options.uxMode !== "redirect")) missing.push("uxMode");
  if (!options || !Array.isArray(options.trustedIssuers) || options.trustedIssuers.length < 1) {
    missing.push("trustedIssuers");
  }
  if (!options || !ownershipKey(options.owner)) missing.push("owner");
  if (!options || !storageReady(options.storage)) missing.push("storage");
  const selected = options ? selectTss(options.chain, options.curve) : null;
  if (!selected) missing.push("curve");
  if (badField(options)) {
    return unavailable("secret-field rejected");
  }
  if (options && oversized(options, 0)) {
    return unavailable("secret-size required");
  }
  if (missing.length > 0) {
    return unavailable(`${missing.join(", ")} required`);
  }
  if (typeof options.subVerifier === "string" && (options.subVerifier.length < 1 || options.subVerifier.length > 256)) {
    return unavailable("subVerifier required");
  }
  return {
    configured: true,
    mode: "mpc",
    chain: selected.chain,
    curve: selected.curve,
    tssPackage: selected.packageName,
    tssExport: selected.exportName,
    manualSync: options.manualSync,
  };
}

export function assessRootAdmin({ claims, env } = {}) {
  const configured = env && typeof env.ROOT_ADMIN_EMAIL === "string"
    ? env.ROOT_ADMIN_EMAIL.trim().toLowerCase()
    : "";
  if (!configured) return { root: false, reason: "root-unset" };
  if (!claims || claims.verified !== true || claims.email_verified !== true) {
    return { root: false, reason: "oidc-verification-required" };
  }
  const key = ownershipKey(claims);
  if (!key) return { root: false, reason: "stable-subject-required" };
  const presented = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!presented || presented !== configured) return { root: false, reason: "not-root" };
  return { root: true, subject: claims.sub, issuer: claims.iss };
}

function containsSecret(value, depth) {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") return /^[0-9a-fA-F]{64}$/.test(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, depth + 1));
  return Object.keys(value).some((key) => SECRET_JSON_KEYS.has(key) || containsSecret(value[key], depth + 1));
}

export function secretShaped(value) {
  if (typeof value !== "string") return false;
  if (utf8Size(value) > 10240) return true;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  try {
    return containsSecret(JSON.parse(value), 0);
  } catch {
    return false;
  }
}

export function secureMetadataStorage(inner) {
  if (!storageReady(inner)) throw new Error("storage required");
  return {
    getItem(key) {
      return inner.getItem(key);
    },
    setItem(key, value) {
      if (secretShaped(typeof value === "string" ? value : "")) {
        throw new Error("secret persistence refused");
      }
      return inner.setItem(key, value);
    },
    removeItem(key) {
      return inner.removeItem(key);
    },
  };
}

export function publicIdentityStatus(source) {
  const status = {
    available: source.available === true,
    mode: "mpc",
    live: source.live === true,
    did: null,
    root: false,
  };
  if (source.reason) status.reason = source.reason;
  if (source.available === true) {
    status.needsFactor = source.needsFactor === true;
    status.curve = source.curve;
    status.chain = source.chain;
    status.custody = "mpc";
  }
  return status;
}
