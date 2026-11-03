/**
 * Cloudflare Worker. Verifies a Turnstile token.
 * Set the secret in Cloudflare only: wrangler secret put TURNSTILE_SECRET
 * Do not commit that secret.
 */
var cors = {
  "access-control-allow-origin": "https://valhalla-app.xyz",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    var url = new URL(request.url);
    if (url.pathname !== "/api/verify" && url.pathname !== "/") {
      return new Response("Not found", { status: 404, headers: cors });
    }
    if (request.method !== "POST") return new Response("POST a token", { status: 405, headers: cors });
    var body = {};
    try { body = await request.json(); } catch (err) { body = {}; }
    var token = String(body.token || "");
    if (!token || !env.TURNSTILE_SECRET) {
      return Response.json({ ok: false }, { status: 400, headers: cors });
    }
    var form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET);
    form.set("response", token);
    var checked = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    var result = await checked.json();
    return Response.json({ ok: result.success === true }, { status: result.success ? 200 : 403, headers: cors });
  }
};
