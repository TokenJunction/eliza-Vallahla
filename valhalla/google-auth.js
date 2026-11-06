function base64url(bytes) {
  var text = "";
  for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createVerifier() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function codeChallenge(verifier) {
  var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier || "")));
  return base64url(new Uint8Array(digest));
}

var SUPABASE_ORIGIN = "https://girltjnrrwlyeufrcors.supabase.co";
var CALLBACKS = ["https://valhalla-app.xyz/app/", "https://www.valhalla-app.xyz/app/"];

export function oauthStateSupport() {
  return {
    supported: false,
    reason: "Supabase GoTrue reserves state as the flow-state id. A client state on /authorize breaks the callback. The PKCE verifier stays required. The worker also checks a one-time nonce."
  };
}

export function authorizeRequest(site, redirectTo, challenge) {
  var url = String(site && site.SUPABASE_URL || "").replace(/\/$/, "");
  var key = String(site && site.SUPABASE_ANON_KEY || "");
  if (url !== SUPABASE_ORIGIN || key.length < 20) return null;
  if (CALLBACKS.indexOf(String(redirectTo || "")) < 0) return null;
  if (!challenge) return null;
  var query = new URLSearchParams({
    provider: "google",
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: "s256",
    scopes: "openid email profile",
  });
  if (query.has("state")) return null;
  return { url: url + "/auth/v1/authorize?" + query.toString(), stateSupported: false };
}

export function callbackCode(search) {
  var params = new URLSearchParams(String(search || ""));
  var error = params.get("error_description") || params.get("error") || "";
  if (error) return { ok: false, error: error };
  var code = params.get("code") || "";
  if (!code) return { ok: false, error: "missing-code" };
  return { ok: true, code: code };
}

export function tokenExchange(site, code, verifier) {
  var url = String(site && site.SUPABASE_URL || "").replace(/\/$/, "");
  var key = String(site && site.SUPABASE_ANON_KEY || "");
  if (url !== "https://girltjnrrwlyeufrcors.supabase.co" || !key || !code || !verifier) return null;
  return {
    url: url + "/auth/v1/token?grant_type=pkce",
    method: "POST",
    headers: {
      apikey: key,
      authorization: "Bearer " + key,
      "content-type": "application/json",
    },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  };
}

export function sessionHandoff(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "incomplete" };
  if (input.email && !input.accessToken) return { ok: false, error: "incomplete" };
  if (input.provider === "google" && !input.accessToken) return { ok: false, error: "incomplete" };
  var accessToken = String(input.accessToken || "");
  if (accessToken.length < 20) return { ok: false, error: "incomplete" };
  return { ok: true, accessToken: accessToken };
}
