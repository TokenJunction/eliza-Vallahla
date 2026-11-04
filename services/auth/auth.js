/**
 * Google ID-token check and email codes.
 * Secrets stay in the Worker: GOOGLE_CLIENT_ID, DEVICE_COOKIE_SECRET,
 * ADMIN_WALLETS, RESEND_API_KEY, and the AUTH_KV id.
 * The code is emailed and stored only as a hash. It is not logged.
 */
import { browserName, codeDecision, needSecondFactor, validEmail } from "./auth-logic.js";

var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];
var TEXT = new TextEncoder();

function cors(request) {
  var origin = request.headers.get("Origin") || "";
  var allow = ALLOWED.indexOf(origin) >= 0 ? origin : "";
  var headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-credentials": "true",
    vary: "Origin"
  };
  if (allow) headers["access-control-allow-origin"] = allow;
  return headers;
}

function json(body, status, request, extra) {
  var headers = cors(request);
  headers["content-type"] = "application/json";
  if (extra) Object.keys(extra).forEach(function (key) { headers[key] = extra[key]; });
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

function b64url(bytes) {
  var raw = "";
  var list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (var i = 0; i < list.length; i += 1) raw += String.fromCharCode(list[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(text) {
  var pad = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  while (pad.length % 4) pad += "=";
  var raw = atob(pad);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha256(text) {
  var buf = await crypto.subtle.digest("SHA-256", TEXT.encode(String(text)));
  return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, body) {
  var key = await crypto.subtle.importKey("raw", TEXT.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, TEXT.encode(body)));
}

async function issue(secret, payload) {
  var body = b64url(TEXT.encode(JSON.stringify(payload)));
  return body + "." + await hmac(secret, body);
}

async function readToken(secret, token) {
  var parts = String(token || "").split(".");
  if (!secret || parts.length !== 2) return null;
  var expected = await hmac(secret, parts[0]);
  if (!safeEqual(expected, parts[1])) return null;
  try {
    var payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function cookieHeader(request) {
  var raw = request.headers.get("Cookie") || "";
  var hit = raw.split(";").map(function (part) { return part.trim(); }).find(function (part) { return part.indexOf("vh_device=") === 0; });
  return hit ? hit.slice("vh_device=".length) : "";
}

function deviceCookie(token) {
  return "vh_device=" + token + "; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=2592000";
}

async function accountOf(env, emailHash) {
  return JSON.parse((await env.AUTH_KV.get("acct:" + emailHash)) || "null") || { devices: [], ips: [], signins: [], alwaysAsk: false };
}

async function saveAccount(env, emailHash, account) {
  account.devices = (account.devices || []).slice(0, 20);
  account.ips = (account.ips || []).slice(0, 10);
  account.signins = (account.signins || []).slice(0, 20);
  await env.AUTH_KV.put("acct:" + emailHash, JSON.stringify(account));
}

function place(request) {
  var cf = request.cf || {};
  return [cf.city, cf.region, cf.country].filter(Boolean).join(", ") || "an unknown area";
}

function when() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date()) + " ET";
}

function six() {
  var buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, "0");
}

async function sendMail(env, to, code, request) {
  var text = [
    "Your Valhalla sign-in code is " + code + ".",
    "",
    "It expires in 10 minutes. You can try 5 times.",
    "Time: " + when(),
    "Place: " + place(request),
    "Browser: " + browserName(request.headers.get("User-Agent")),
    "",
    "If this was not you, secure your account. Valhalla will not ask for a seed phrase."
  ].join("\n");
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    try {
      await env.EMAIL.send({
        to: to,
        from: { email: "noreply@valhalla-app.xyz", name: "Valhalla" },
        subject: "Your Valhalla sign-in code",
        text: text
      });
      return "cloudflare";
    } catch (err) {
      if (!env.RESEND_API_KEY) throw err;
    }
  }
  if (!env.RESEND_API_KEY) return "";
  var response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: "Valhalla <noreply@valhalla-app.xyz>",
      to: [to],
      subject: "Your Valhalla sign-in code",
      text: text
    })
  });
  if (!response.ok) throw new Error("resend");
  return "resend";
}

async function limited(env, key, max) {
  var count = Number((await env.AUTH_KV.get(key)) || 0);
  if (count >= max) return false;
  await env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function startCode(env, email, request, options) {
  options = options || {};
  var emailHash = await sha256(email);
  var ip = request.headers.get("CF-Connecting-IP") || "";
  var ipHash = await sha256(ip || "none");
  var hour = new Date().toISOString().slice(0, 13);
  if (!(await limited(env, "rl:e:" + emailHash + ":" + hour, 5))) return { ok: false, error: "rate" };
  if (!(await limited(env, "rl:i:" + ipHash + ":" + hour, 20))) return { ok: false, error: "rate" };
  var code = six();
  var salt = crypto.randomUUID();
  var sent = "";
  try {
    sent = await sendMail(env, email, code, request);
  } catch (err) {
    return { ok: false, error: "email" };
  }
  if (!sent) return { ok: false, error: "email-not-configured" };
  await env.AUTH_KV.put("code:" + emailHash, JSON.stringify({
    salt: salt,
    hash: await sha256(code + ":" + salt + ":" + email),
    attempts: 0,
    alwaysAsk: options.alwaysAsk === true,
    exp: Date.now() + 10 * 60 * 1000
  }), { expirationTtl: 600 });
  return { ok: true };
}

async function checkCode(env, email, code) {
  var emailHash = await sha256(email);
  var key = "code:" + emailHash;
  var record = JSON.parse((await env.AUTH_KV.get(key)) || "null");
  var state = codeDecision(record, Date.now());
  if (state !== "ok") return { ok: false, error: state };
  record.attempts += 1;
  var expected = await sha256(String(code || "") + ":" + record.salt + ":" + email);
  if (!safeEqual(expected, record.hash)) {
    if (record.attempts >= 5) await env.AUTH_KV.delete(key);
    else await env.AUTH_KV.put(key, JSON.stringify(record), { expirationTtl: 600 });
    return { ok: false, error: record.attempts >= 5 ? "locked" : "code" };
  }
  await env.AUTH_KV.delete(key);
  return { ok: true, emailHash: emailHash, alwaysAsk: record.alwaysAsk === true };
}

async function sessionFor(env, emailHash, request, codeThisLogin) {
  var account = await accountOf(env, emailHash);
  var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
  var existing = await readToken(env.DEVICE_COOKIE_SECRET, cookieHeader(request));
  var knownDevice = Boolean(existing && existing.eh === emailHash && (account.devices || []).some(function (row) { return row.id === existing.did; }));
  var knownIp = (account.ips || []).indexOf(ipHash) >= 0;
  var need = needSecondFactor({
    knownDevice: knownDevice,
    knownIp: knownIp,
    alwaysAsk: account.alwaysAsk === true,
    leader: false,
    codeThisLogin: codeThisLogin === true
  });
  if (need && !codeThisLogin) return { needCode: true, account: account, ipHash: ipHash };
  var did = knownDevice ? existing.did : crypto.randomUUID();
  var now = Date.now();
  var device = (account.devices || []).find(function (row) { return row.id === did; }) || {
    id: did,
    created: now,
    city: place(request),
    browser: browserName(request.headers.get("User-Agent"))
  };
  device.last = now;
  account.devices = [device].concat((account.devices || []).filter(function (row) { return row.id !== did; }));
  if (account.ips.indexOf(ipHash) < 0) account.ips.unshift(ipHash);
  account.signins.unshift({ at: now, city: place(request), browser: device.browser, ok: true });
  await saveAccount(env, emailHash, account);
  var exp = now + 12 * 60 * 60 * 1000;
  var session = await issue(env.DEVICE_COOKIE_SECRET, { eh: emailHash, did: did, exp: exp, code: codeThisLogin === true });
  var cookie = await issue(env.DEVICE_COOKIE_SECRET, { eh: emailHash, did: did, exp: now + 30 * 24 * 60 * 60 * 1000 });
  return { needCode: false, session: session, cookie: deviceCookie(cookie) };
}

function bearer(request) {
  var header = request.headers.get("Authorization") || "";
  return header.toLowerCase().indexOf("bearer ") === 0 ? header.slice(7).trim() : "";
}

async function googleInfo(env, credential) {
  var response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!response.ok) return null;
  var info = await response.json();
  var iss = String(info.iss || "");
  var verified = info.email_verified === true || info.email_verified === "true";
  var scope = String(info.scope || "");
  if (info.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return null;
  if (Number(info.exp) * 1000 < Date.now()) return null;
  if (!verified || !validEmail(info.email)) return null;
  if (/gmail|drive/i.test(scope)) return null;
  return { email: String(info.email).toLowerCase(), name: String(info.name || ""), picture: String(info.picture || "") };
}

function b58(text) {
  var alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var bytes = [0];
  for (var i = 0; i < text.length; i += 1) {
    var value = alphabet.indexOf(text[i]);
    if (value < 0) return new Uint8Array();
    var carry = value;
    for (var j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  var zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  var out = new Uint8Array(zeros + bytes.length);
  for (var k = 0; k < bytes.length; k += 1) out[out.length - 1 - k] = bytes[k];
  return out;
}

async function leaderProof(env, body) {
  var allow = String(env.ADMIN_WALLETS || "").split(",").map(function (item) { return item.trim(); }).filter(Boolean);
  var pubkey = String(body.pubkey || "");
  var message = String(body.message || "");
  if (!allow.length || allow.indexOf(pubkey) < 0) return false;
  if (message.indexOf("Sign in to Valhalla") < 0 || message.indexOf("This is not a transaction.") < 0) return false;
  if (message.indexOf(pubkey) < 0) return false;
  var exp = Date.parse((message.match(/Expiration Time: (.+)/) || [])[1] || "");
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  var pub = b58(pubkey);
  var sig = Uint8Array.from(atob(String(body.signature || "")), function (char) { return char.charCodeAt(0); });
  if (pub.length !== 32 || sig.length !== 64) return false;
  var key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig, TEXT.encode(message));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!env.AUTH_KV || !env.DEVICE_COOKIE_SECRET || !env.GOOGLE_CLIENT_ID) {
      return json({ ok: false, error: "auth-not-configured" }, 503, request);
    }
    var url = new URL(request.url);
    var body = request.method === "POST" ? await request.json().catch(function () { return {}; }) : {};
    if (url.pathname === "/auth/google" && request.method === "POST") {
      var info = await googleInfo(env, String(body.credential || ""));
      if (!info) return json({ ok: false, error: "google" }, 401, request);
      var emailHash = await sha256(info.email);
      var account = await accountOf(env, emailHash);
      account.email = info.email;
      if (body.alwaysAsk === true) account.alwaysAsk = true;
      await saveAccount(env, emailHash, account);
      var next = await sessionFor(env, emailHash, request, false);
      if (next.needCode) {
        var sent = await startCode(env, info.email, request, { alwaysAsk: body.alwaysAsk === true });
        if (!sent.ok) return json(sent, sent.error === "rate" ? 429 : 503, request);
        return json({ ok: true, needCode: true, email: info.email, name: info.name, picture: info.picture }, 200, request);
      }
      return json({ ok: true, needCode: false, email: info.email, name: info.name, picture: info.picture, session: next.session }, 200, request, { "set-cookie": next.cookie });
    }
    if (url.pathname === "/auth/email/start" && request.method === "POST") {
      var email = String(body.email || "").toLowerCase().trim();
      if (!validEmail(email)) return json({ ok: false, error: "email" }, 400, request);
      var started = await startCode(env, email, request, { alwaysAsk: body.alwaysAsk === true });
      return json(started.ok ? { ok: true } : started, started.ok ? 200 : started.error === "rate" ? 429 : 503, request);
    }
    if (url.pathname === "/auth/email/verify" && request.method === "POST") {
      var checkEmail = String(body.email || "").toLowerCase().trim();
      var checked = await checkCode(env, checkEmail, String(body.code || ""));
      if (!checked.ok) return json({ ok: false, error: checked.error }, 401, request);
      var verifiedAccount = await accountOf(env, checked.emailHash);
      verifiedAccount.email = checkEmail;
      if (checked.alwaysAsk) verifiedAccount.alwaysAsk = true;
      await saveAccount(env, checked.emailHash, verifiedAccount);
      var ready = await sessionFor(env, checked.emailHash, request, true);
      return json({ ok: true, needCode: false, email: checkEmail, session: ready.session }, 200, request, { "set-cookie": ready.cookie });
    }
    var session = await readToken(env.DEVICE_COOKIE_SECRET, bearer(request));
    if (!session) return json({ ok: false, error: "session" }, 401, request);
    var activeAccount = await accountOf(env, session.eh);
    if (!(activeAccount.devices || []).some(function (row) { return row.id === session.did; })) {
      return json({ ok: false, error: "session-revoked" }, 401, request);
    }
    if (url.pathname === "/auth/leader" && request.method === "POST") {
      var isLeader = await leaderProof(env, body);
      var must = needSecondFactor({
        knownDevice: true,
        knownIp: true,
        alwaysAsk: false,
        leader: isLeader,
        codeThisLogin: session.code === true
      });
      if (isLeader && must) {
        if (!validEmail(activeAccount.email)) return json({ ok: false, error: "email-not-configured" }, 503, request);
        var leaderCode = await startCode(env, activeAccount.email, request);
        if (!leaderCode.ok) return json(leaderCode, leaderCode.error === "rate" ? 429 : 503, request);
        return json({ ok: true, role: "leader", needCode: true, email: activeAccount.email }, 200, request);
      }
      return json({ ok: true, role: isLeader ? "leader" : "member", needCode: must }, 200, request);
    }
    if (url.pathname === "/auth/devices" && request.method === "GET") {
      var account = await accountOf(env, session.eh);
      return json({
        ok: true,
        alwaysAsk: account.alwaysAsk === true,
        devices: (account.devices || []).map(function (row) {
          return { id: row.id, city: row.city, browser: row.browser, created: row.created, last: row.last, current: row.id === session.did };
        }),
        signins: account.signins || []
      }, 200, request);
    }
    if (url.pathname === "/auth/devices/revoke" && request.method === "POST") {
      var account = await accountOf(env, session.eh);
      account.devices = (account.devices || []).filter(function (row) { return row.id !== String(body.id || ""); });
      await saveAccount(env, session.eh, account);
      await env.AUTH_KV.delete("device:" + String(body.id || ""));
      return json({ ok: true }, 200, request);
    }
    if (url.pathname === "/auth/security" && request.method === "POST") {
      var account = await accountOf(env, session.eh);
      account.alwaysAsk = body.alwaysAsk === true;
      await saveAccount(env, session.eh, account);
      return json({ ok: true, alwaysAsk: account.alwaysAsk }, 200, request);
    }
    return json({ ok: false, error: "not-found" }, 404, request);
  }
};
