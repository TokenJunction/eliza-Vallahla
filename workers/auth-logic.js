/** Pure sign-in rules. No secrets and no codes. */

export function needSecondFactor(input) {
  if (input && input.codeThisLogin === true) return false;
  // Opting out does not skip the code for an unknown device or when the user asked to be challenged.
  if (input && input.secondFactor === false && input.knownDevice === true && input.alwaysAsk !== true) return false;
  return true;
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

export function sessionApiCookies(token, csrf) {
  var maxAge = 12 * 60 * 60;
  return [
    "vh_session=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=" + maxAge,
    "vh_csrf=" + csrf + "; Secure; SameSite=Lax; Path=/api; Max-Age=" + maxAge
  ];
}
