/**
 * Reference copy of the Worker already deployed as "valhalla-turnstile-verify".
 * Live URL: https://valhalla-turnstile-verify.valhalla-app.workers.dev/api/verify
 * Do not deploy this file over that Worker unless you mean to replace it.
 * TURNSTILE_SECRET is set in Cloudflare only. It is not in this repo.
 */
var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];

function corsHeaders(request) {
  var origin = request.headers.get("Origin") || "";
  var allow = ALLOWED.indexOf(origin) >= 0 ? origin : ALLOWED[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

export default {
  async fetch(request, env) {
    var headers = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: headers });
    var url = new URL(request.url);
    if (url.pathname !== "/api/verify") {
      return new Response("Not found", { status: 404, headers: headers });
    }
    if (request.method !== "POST") return new Response("POST a token", { status: 405, headers: headers });
    var body = {};
    try { body = await request.json(); } catch (err) { body = {}; }
    var token = String(body.token || "");
    if (!token || !env.TURNSTILE_SECRET) {
      return Response.json({ success: false, ok: false }, { status: 400, headers: headers });
    }
    var form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET);
    form.set("response", token);
    var checked = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    var result = await checked.json();
    var passed = result.success === true;
    return Response.json({ success: passed, ok: passed }, { status: passed ? 200 : 403, headers: headers });
  }
};
