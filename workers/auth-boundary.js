const ALLOWED = new Set(["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"]);
const SIGN_IN = new Set(["/auth/google", "/auth/email/start"]);
function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, private, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function reject(status, error) {
  return noStore(new Response(JSON.stringify({ ok: false, error }), { status, headers: { "Content-Type": "application/json" } }));
}
export function createAuthBoundary(delegate) {
  return {
    async fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      const protectedRequest = request.method === "POST" || request.method === "OPTIONS" || path === "/auth/nonce";
      if (protectedRequest && !ALLOWED.has(request.headers.get("Origin"))) return reject(403, "origin");
      let forwarded = request;
      if (request.method === "POST" && SIGN_IN.has(path)) {
        if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return reject(415, "content-type");
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > 16384) return reject(413, "request-too-large");
        let body;
        try { body = JSON.parse(raw); } catch { return reject(400, "json"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400, "json");
        // Only the authenticated /auth/security route may change this preference.
        delete body.alwaysAsk;
        const headers = new Headers(request.headers);
        headers.delete("Content-Length");
        forwarded = new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
      }
      return noStore(await delegate.fetch(forwarded, env, context));
    }
  };
}
