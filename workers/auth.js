/**
 * Google ID-token check and email codes.
 * Secrets stay in the Worker: GOOGLE_CLIENT_ID, DEVICE_COOKIE_SECRET,
 * RESEND_API_KEY, optional TURNSTILE_SECRET, and the AUTH_KV id.
 * The code is emailed and stored only as a hash. It is not logged.
 * Access and device tokens work only while a matching sess: record exists.
 */
import { browserName, codeDecision, maskEmail, needSecondFactor, opaqueId, sensitiveSignIn, sessionMatches, turnstileEnforced, validEmail } from "./auth-logic.js";

var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];
var TURNSTILE_HOSTS = ["valhalla-app.xyz", "www.valhalla-app.xyz"];
var TURNSTILE_ACTION = "valhalla-signin";
var TEXT = new TextEncoder();
var CHAT_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano"];
var ENGAGEMENT_EVENTS = [
  "page_view", "paper_start", "paper_pause", "paper_stop", "chat_send",
  "settings_open", "upgrade_open", "load_under_1s", "load_1_3s",
  "load_3_5s", "load_over_5s"
];

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

function ttlFor(exp) {
  var sec = Math.ceil((Number(exp) - Date.now()) / 1000);
  if (!Number.isFinite(sec) || sec < 60) return 60;
  if (sec > 30 * 24 * 60 * 60) return 30 * 24 * 60 * 60;
  return sec;
}

function randomHex(bytes) {
  var buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  var out = "";
  for (var i = 0; i < buf.length; i += 1) out += buf[i].toString(16).padStart(2, "0");
  return out;
}

async function readToken(secret, token, env) {
  var parts = String(token || "").split(".");
  if (!secret || !env || !env.AUTH_KV || parts.length !== 2) return null;
  var expected = await hmac(secret, parts[0]);
  if (!safeEqual(expected, parts[1])) return null;
  try {
    var payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload || !payload.sid) return null;
    var record = JSON.parse((await env.AUTH_KV.get("sess:" + payload.sid)) || "null");
    if (sessionMatches(record, payload, Date.now()) !== "ok") return null;
    if (await env.AUTH_KV.get("revoked:" + record.did)) return null;
    return {
      eh: record.eh,
      did: record.did,
      exp: Number(record.exp),
      code: record.code === true,
      google: record.google === true,
      sid: record.sid,
      sv: Number(record.v),
      use: record.use
    };
  } catch (err) {
    return null;
  }
}

async function putSession(env, record) {
  await env.AUTH_KV.put("sess:" + record.sid, JSON.stringify(record), { expirationTtl: ttlFor(record.exp) });
}

async function retireSession(env, sid) {
  if (sid) await env.AUTH_KV.delete("sess:" + sid);
}

async function revokeDevice(env, did) {
  if (!did) return;
  await env.AUTH_KV.put("revoked:" + did, "1", { expirationTtl: 30 * 24 * 60 * 60 });
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

async function startCode(env, email, request, googleVerified) {
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
  var pending = randomHex(16);
  var hint = maskEmail(email);
  await env.AUTH_KV.put("code:" + emailHash, JSON.stringify({
    salt: salt,
    hash: await sha256(code + ":" + salt + ":" + emailHash),
    attempts: 0,
    googleVerified: googleVerified === true,
    hint: hint,
    exp: Date.now() + 10 * 60 * 1000
  }), { expirationTtl: 600 });
  await env.AUTH_KV.put("pend:" + pending, JSON.stringify({
    emailHash: emailHash,
    exp: Date.now() + 10 * 60 * 1000
  }), { expirationTtl: 600 });
  return { ok: true, hint: hint, pending: pending };
}

async function checkCode(env, pending, code) {
  var id = opaqueId(pending);
  if (!id) return { ok: false, error: "missing" };
  var pendingRecord = JSON.parse((await env.AUTH_KV.get("pend:" + id)) || "null");
  if (!pendingRecord || !pendingRecord.emailHash) return { ok: false, error: "missing" };
  var emailHash = pendingRecord.emailHash;
  var key = "code:" + emailHash;
  var record = JSON.parse((await env.AUTH_KV.get(key)) || "null");
  var state = codeDecision(record, Date.now());
  if (state !== "ok") return { ok: false, error: state };
  record.attempts += 1;
  var expected = await sha256(String(code || "") + ":" + record.salt + ":" + emailHash);
  if (!safeEqual(expected, record.hash)) {
    if (record.attempts >= 5) {
      await env.AUTH_KV.delete(key);
      await env.AUTH_KV.delete("pend:" + id);
    } else await env.AUTH_KV.put(key, JSON.stringify(record), { expirationTtl: 600 });
    return { ok: false, error: record.attempts >= 5 ? "locked" : "code" };
  }
  await env.AUTH_KV.delete(key);
  await env.AUTH_KV.delete("pend:" + id);
  return { ok: true, emailHash: emailHash, googleVerified: record.googleVerified === true, hint: record.hint || "" };
}

async function sessionFor(env, emailHash, request, codeThisLogin, googleVerified) {
  var account = await accountOf(env, emailHash);
  var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
  var existing = await readToken(env.DEVICE_COOKIE_SECRET, cookieHeader(request), env);
  if (existing && existing.use !== "device") existing = null;
  var deviceRevoked = Boolean(existing && await env.AUTH_KV.get("revoked:" + existing.did));
  var knownDevice = Boolean(existing && !deviceRevoked && existing.eh === emailHash && (account.devices || []).some(function (row) { return row.id === existing.did && row.revoked !== true; }));
  var knownIp = (account.ips || []).indexOf(ipHash) >= 0;
  var configuredLeader = leaderEmail(env);
  var leader = Boolean(configuredLeader) && safeEqual(emailHash, await sha256(configuredLeader));
  var need = needSecondFactor({
    knownDevice: knownDevice,
    knownIp: knownIp,
    alwaysAsk: account.alwaysAsk === true,
    leader: leader,
    revoked: deviceRevoked,
    baseVerified: googleVerified === true || codeThisLogin === true,
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
  var previousAccess = device.accessSid || "";
  var previousCookie = device.cookieSid || "";
  device.last = now;
  device.accessSid = crypto.randomUUID();
  device.cookieSid = crypto.randomUUID();
  account.devices = [device].concat((account.devices || []).filter(function (row) { return row.id !== did; }));
  if (account.ips.indexOf(ipHash) < 0) account.ips.unshift(ipHash);
  account.signins.unshift({ at: now, city: place(request), browser: device.browser, ok: true });
  var accessExp = now + 12 * 60 * 60 * 1000;
  var cookieExp = now + 30 * 24 * 60 * 60 * 1000;
  await retireSession(env, previousAccess);
  await retireSession(env, previousCookie);
  await putSession(env, {
    sid: device.accessSid,
    v: 1,
    eh: emailHash,
    did: did,
    exp: accessExp,
    code: codeThisLogin === true,
    google: googleVerified === true,
    use: "access"
  });
  await putSession(env, {
    sid: device.cookieSid,
    v: 1,
    eh: emailHash,
    did: did,
    exp: cookieExp,
    code: false,
    google: false,
    use: "device"
  });
  await saveAccount(env, emailHash, account);
  var session = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: emailHash,
    did: did,
    exp: accessExp,
    code: codeThisLogin === true,
    google: googleVerified === true,
    sid: device.accessSid,
    sv: 1,
    use: "access"
  });
  var cookie = await issue(env.DEVICE_COOKIE_SECRET, {
    eh: emailHash,
    did: did,
    exp: cookieExp,
    code: false,
    google: false,
    sid: device.cookieSid,
    sv: 1,
    use: "device"
  });
  return { needCode: false, session: session, cookie: deviceCookie(cookie) };
}

function leaderEmail(env) {
  return String(env && env.LEADER_EMAIL ? env.LEADER_EMAIL : "").trim().toLowerCase();
}

async function isLeader(env, session) {
  var email = leaderEmail(env);
  if (!email || !session || session.code !== true || session.google !== true) return false;
  var expected = await sha256(email);
  return safeEqual(String(session.eh || ""), expected);
}

async function loginRedirect(env, emailHash, googleVerified, codeVerified) {
  var leader = await isLeader(env, { eh: emailHash, code: codeVerified === true, google: googleVerified === true });
  return leader ? "/admin/master-control/" : "/dashboard/analytics/";
}

function bearer(request) {
  var header = request.headers.get("Authorization") || "";
  return header.toLowerCase().indexOf("bearer ") === 0 ? header.slice(7).trim() : "";
}

async function nonceReady(env, nonce) {
  var id = opaqueId(nonce);
  if (!id) return false;
  return Boolean(await env.AUTH_KV.get("nonce:" + id));
}

async function consumeNonce(env, nonce) {
  var id = opaqueId(nonce);
  if (!id) return false;
  var key = "nonce:" + id;
  if (!(await env.AUTH_KV.get(key))) return false;
  await env.AUTH_KV.delete(key);
  return true;
}

async function verifyTurnstile(env, request, token) {
  if (!turnstileEnforced(env && env.TURNSTILE_SECRET)) return { ok: true, enforced: false };
  var value = String(token || "");
  if (!value) return { ok: false, error: "turnstile" };
  var seen = "ts:" + await sha256(value);
  if (await env.AUTH_KV.get(seen)) return { ok: false, error: "turnstile" };
  await env.AUTH_KV.put(seen, "1", { expirationTtl: 600 });
  var form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", value);
  var ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  try {
    var checked = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    if (!checked.ok) return { ok: false, error: "turnstile" };
    var result = await checked.json();
    var errors = result && Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
    if (!result || result.success !== true) return { ok: false, error: "turnstile" };
    if (errors.indexOf("timeout-or-duplicate") >= 0) return { ok: false, error: "turnstile" };
    if (result.action !== TURNSTILE_ACTION) return { ok: false, error: "turnstile" };
    if (TURNSTILE_HOSTS.indexOf(String(result.hostname || "")) < 0) return { ok: false, error: "turnstile" };
    return { ok: true, enforced: true };
  } catch (err) {
    return { ok: false, error: "turnstile" };
  }
}

async function humanPassOk(env, human) {
  if (!turnstileEnforced(env && env.TURNSTILE_SECRET)) return true;
  var id = opaqueId(human);
  if (!id) return false;
  return Boolean(await env.AUTH_KV.get("human:" + id));
}

function clearDeviceCookie() {
  return "vh_device=; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=0";
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
  return {
    email: String(info.email).toLowerCase(),
    name: String(info.name || ""),
    picture: String(info.picture || ""),
    exp: Number(info.exp)
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!env.AUTH_KV || !env.DEVICE_COOKIE_SECRET || !env.GOOGLE_CLIENT_ID) {
      return json({ ok: false, error: "auth-not-configured" }, 503, request);
    }
    var url = new URL(request.url);
    var body = request.method === "POST" ? await request.json().catch(function () { return {}; }) : {};
    if (url.pathname === "/auth/nonce" && request.method === "GET") {
      var ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "none");
      var hour = new Date().toISOString().slice(0, 13);
      if (!(await limited(env, "rl:n:" + ipHash + ":" + hour, 30))) return json({ ok: false, error: "rate" }, 429, request);
      var nonce = randomHex(16);
      await env.AUTH_KV.put("nonce:" + nonce, "1", { expirationTtl: 600 });
      return json({ ok: true, nonce: nonce }, 200, request);
    }
    if (url.pathname === "/auth/human" && request.method === "POST") {
      if (!turnstileEnforced(env.TURNSTILE_SECRET)) return json({ ok: true, enforced: false }, 200, request);
      var humanIp = await sha256(request.headers.get("CF-Connecting-IP") || "none");
      var humanHour = new Date().toISOString().slice(0, 13);
      if (!(await limited(env, "rl:h:" + humanIp + ":" + humanHour, 30))) return json({ ok: false, error: "rate" }, 429, request);
      var checkedHuman = await verifyTurnstile(env, request, body.token);
      if (!checkedHuman.ok) return json({ ok: false, error: "turnstile" }, 403, request);
      var human = randomHex(16);
      await env.AUTH_KV.put("human:" + human, "1", { expirationTtl: 1800 });
      return json({ ok: true, enforced: true, human: human }, 200, request);
    }
    if (sensitiveSignIn(url.pathname, request.method)) {
      if (!(await nonceReady(env, body.nonce))) return json({ ok: false, error: "nonce" }, 401, request);
      if (!(await humanPassOk(env, body.human))) return json({ ok: false, error: "turnstile" }, 403, request);
      if (!(await consumeNonce(env, body.nonce))) return json({ ok: false, error: "nonce" }, 401, request);
    }
    if (url.pathname === "/auth/google" && request.method === "POST") {
      var credential = String(body.credential || "");
      var info = await googleInfo(env, credential);
      if (!info) return json({ ok: false, error: "google" }, 401, request);
      var marker = "gcred:" + await sha256(credential);
      if (await env.AUTH_KV.get(marker)) return json({ ok: false, error: "replay" }, 401, request);
      var markerTtl = Math.floor(info.exp - Date.now() / 1000);
      if (!Number.isFinite(markerTtl) || markerTtl < 60) markerTtl = 60;
      if (markerTtl > 3600) markerTtl = 3600;
      await env.AUTH_KV.put(marker, "1", { expirationTtl: markerTtl });
      var emailHash = await sha256(info.email);
      var account = await accountOf(env, emailHash);
      if (body.alwaysAsk === true) account.alwaysAsk = true;
      if (body.alwaysAsk === false) account.alwaysAsk = false;
      await saveAccount(env, emailHash, account);
      var next = await sessionFor(env, emailHash, request, false, true);
      if (next.needCode) {
        var sent = await startCode(env, info.email, request, true);
        if (!sent.ok) return json(sent, sent.error === "rate" ? 429 : 503, request);
        return json({ ok: true, needCode: true, hint: sent.hint, pending: sent.pending }, 200, request);
      }
      return json({
        ok: true,
        needCode: false,
        hint: maskEmail(info.email),
        session: next.session,
        redirect: await loginRedirect(env, emailHash, true, false)
      }, 200, request, { "set-cookie": next.cookie });
    }
    if (url.pathname === "/auth/email/start" && request.method === "POST") {
      var email = String(body.email || "").toLowerCase().trim();
      if (!validEmail(email)) return json({ ok: false, error: "email" }, 400, request);
      if (body.alwaysAsk === true || body.alwaysAsk === false) {
        var hash = await sha256(email);
        var existing = await accountOf(env, hash);
        existing.alwaysAsk = body.alwaysAsk === true;
        await saveAccount(env, hash, existing);
      }
      var started = await startCode(env, email, request, false);
      return json(started.ok ? { ok: true, hint: started.hint, pending: started.pending } : started, started.ok ? 200 : started.error === "rate" ? 429 : 503, request);
    }
    if (url.pathname === "/auth/email/verify" && request.method === "POST") {
      var checked = await checkCode(env, body.pending, String(body.code || ""));
      if (!checked.ok) return json({ ok: false, error: checked.error }, 401, request);
      var ready = await sessionFor(env, checked.emailHash, request, true, checked.googleVerified);
      return json({
        ok: true,
        needCode: false,
        hint: checked.hint,
        session: ready.session,
        redirect: await loginRedirect(env, checked.emailHash, checked.googleVerified, true)
      }, 200, request, { "set-cookie": ready.cookie });
    }
    if (url.pathname === "/auth/chat-config" && request.method === "GET") {
      var config = JSON.parse((await env.AUTH_KV.get("manager:chat-config")) || "{}");
      var model = CHAT_MODELS.indexOf(config.model) >= 0 ? config.model : CHAT_MODELS[0];
      return json({ provider: "openai", model: model, models: CHAT_MODELS }, 200, request);
    }
    var session = await readToken(env.DEVICE_COOKIE_SECRET, bearer(request), env);
    if (!session || session.use !== "access") return json({ ok: false, error: "session" }, 401, request);
    if (url.pathname === "/auth/access" && request.method === "GET") {
      var account = await accountOf(env, session.eh);
      var subscriber = account.plan === "pro";
      var leader = await isLeader(env, session);
      return json({
        ok: true,
        plan: subscriber ? "pro" : "free",
        subscriber: subscriber,
        leader: leader,
        subject: session.eh,
        sessionId: session.sid,
        google: session.google === true,
        code: session.code === true,
        expires: session.exp
      }, 200, request);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      var loggedOut = await accountOf(env, session.eh);
      var current = (loggedOut.devices || []).find(function (row) { return row.id === session.did; });
      var deviceToken = await readToken(env.DEVICE_COOKIE_SECRET, cookieHeader(request), env);
      if (deviceToken && deviceToken.use === "device" && deviceToken.eh === session.eh) {
        await retireSession(env, deviceToken.sid);
        await revokeDevice(env, deviceToken.did);
      }
      if (current) {
        await retireSession(env, current.accessSid);
        await retireSession(env, current.cookieSid);
        current.revoked = true;
        current.accessSid = "";
        current.cookieSid = "";
        await saveAccount(env, session.eh, loggedOut);
      }
      await revokeDevice(env, session.did);
      await retireSession(env, session.sid);
      return json({ ok: true }, 200, request, { "set-cookie": clearDeviceCookie() });
    }
    if (url.pathname === "/auth/leader" && request.method === "POST") {
      var leader = await isLeader(env, session);
      return json({ ok: true, role: leader ? "leader" : "member" }, 200, request);
    }
    if (url.pathname === "/auth/chat-config" && request.method === "POST") {
      if (!(await isLeader(env, session))) return json({ ok: false, error: "leader-required" }, 403, request);
      var model = String(body.model || "");
      if (CHAT_MODELS.indexOf(model) < 0) return json({ ok: false, error: "unsupported-model" }, 400, request);
      await env.AUTH_KV.put("manager:chat-config", JSON.stringify({
        provider: "openai",
        model: model,
        updatedAt: new Date().toISOString()
      }));
      return json({ ok: true, provider: "openai", model: model }, 200, request);
    }
    if (url.pathname === "/auth/engagement" && request.method === "POST") {
      if (session.code !== true || body.analyticsConsent !== true) {
        return json({ ok: false, error: "analytics-consent-required" }, 403, request);
      }
      var eventName = String(body.event || "");
      if (ENGAGEMENT_EVENTS.indexOf(eventName) < 0) {
        return json({ ok: false, error: "unsupported-event" }, 400, request);
      }
      var day = new Date().toISOString().slice(0, 10);
      var key = "engagement:" + day + ":" + eventName;
      var count = Number(await env.AUTH_KV.get(key)) || 0;
      await env.AUTH_KV.put(key, String(count + 1), { expirationTtl: 691200 });
      return json({ ok: true }, 202, request);
    }
    if (url.pathname === "/auth/engagement" && request.method === "GET") {
      if (!(await isLeader(env, session))) return json({ ok: false, error: "leader-required" }, 403, request);
      var days = [];
      for (var offset = 6; offset >= 0; offset -= 1) {
        var date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        var row = { date: date };
        for (var i = 0; i < ENGAGEMENT_EVENTS.length; i += 1) {
          var eventName = ENGAGEMENT_EVENTS[i];
          row[eventName] = Number(await env.AUTH_KV.get("engagement:" + date + ":" + eventName)) || 0;
        }
        days.push(row);
      }
      return json({ days: days, approximate: true }, 200, request);
    }
    if (url.pathname === "/auth/devices" && request.method === "GET") {
      var account = await accountOf(env, session.eh);
      return json({
        ok: true,
        alwaysAsk: account.alwaysAsk === true,
        devices: (account.devices || []).filter(function (row) { return row.revoked !== true; }).map(function (row) {
          return { id: row.id, city: row.city, browser: row.browser, created: row.created, last: row.last, current: row.id === session.did };
        }),
        signins: account.signins || []
      }, 200, request);
    }
    if (url.pathname === "/auth/devices/revoke" && request.method === "POST") {
      var revokeId = String(body.id || "");
      var account = await accountOf(env, session.eh);
      var doomed = (account.devices || []).find(function (row) { return row.id === revokeId; });
      account.devices = (account.devices || []).filter(function (row) { return row.id !== revokeId; });
      await saveAccount(env, session.eh, account);
      if (doomed) {
        await retireSession(env, doomed.accessSid);
        await retireSession(env, doomed.cookieSid);
        doomed.revoked = true;
      }
      await revokeDevice(env, revokeId);
      if (revokeId === session.did) await retireSession(env, session.sid);
      await env.AUTH_KV.delete("device:" + revokeId);
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
