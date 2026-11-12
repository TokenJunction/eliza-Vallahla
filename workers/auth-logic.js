/** Pure sign-in rules. No secrets and no codes. */

export function needSecondFactor(input) {
  var source = input || {};
  if (source.codeThisLogin === true) return false;
  if (source.baseVerified !== true) return true;
  if (source.alwaysAsk === true || source.leader === true || source.revoked === true ||
      source.knownDevice !== true || source.knownIp !== true) return true;
  return source.secondFactor !== false;
}

export function codeDecision(record, now) {
  if (!record) return "missing";
  if (Number(record.exp) < now) return "expired";
  if (Number(record.attempts) >= 5) return "locked";
  return "ok";
}

export function browserName(ua) {
  var text = String(ua || "");
  if (text.indexOf("Edg/") >= 0) return "Edge";
  if (text.indexOf("Chrome/") >= 0) return "Chrome";
  if (text.indexOf("Firefox/") >= 0) return "Firefox";
  if (text.indexOf("Safari/") >= 0) return "Safari";
  return "a browser";
}

export function maskEmail(email) {
  var parts = String(email || "").toLowerCase().split("@");
  if (parts.length !== 2 || parts[0].length < 1 || parts[1].indexOf(".") < 0) return "your email";
  return parts[0].slice(0, 1) + "***@" + parts[1];
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").toLowerCase());
}

var OPAQUE = /^[0-9a-f]{32}$/;
var SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var EMAIL_HASH = /^[0-9a-f]{64}$/;

export function opaqueId(value) {
  var text = String(value || "");
  return OPAQUE.test(text) ? text : "";
}

export function turnstileEnforced(secret) {
  return String(secret || "").length > 0;
}

export function sensitiveSignIn(pathname, method) {
  return method === "POST" && (
    pathname === "/auth/google" ||
    pathname === "/auth/email/start" ||
    pathname === "/auth/email/verify"
  );
}

export function sessionMatches(record, claims, now) {
  if (!record || !claims) return "missing";
  if (record.use !== "access" && record.use !== "device") return "mismatch";
  if (claims.use !== record.use) return "mismatch";
  if (!EMAIL_HASH.test(String(record.eh || "")) || String(record.eh) !== String(claims.eh || "")) return "mismatch";
  if (!record.did || String(record.did) !== String(claims.did || "")) return "mismatch";
  if (!SESSION_ID.test(String(claims.sid || "")) || String(claims.sid) !== String(record.sid || "")) return "mismatch";
  if (Number(record.v) !== Number(claims.sv)) return "revoked";
  if ((record.code === true) !== (claims.code === true)) return "mismatch";
  if ((record.google === true) !== (claims.google === true)) return "mismatch";
  if (Number(record.exp) !== Number(claims.exp)) return "mismatch";
  if (Number(record.exp) < now) return "expired";
  return "ok";
}
