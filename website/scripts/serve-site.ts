/* Original local ValOS static server. SPDX-License-Identifier: MIT */
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "../../site-build");
const port = Number(process.env.PORT || 8765);
const host = "0.0.0.0";

function fileFor(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) return null;
  const relative = (decoded.endsWith("/") ? decoded + "index.html" : decoded).replace(/^\/+/, "");
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) return null;
  return full;
}

Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", scope: "local-static-desk", liveTrading: false });
    }
    if (url.pathname === "/valos-shell.json") {
      return Response.json({ bun: true, scope: "local-helper" });
    }
    const full = fileFor(url.pathname);
    if (!full) return new Response("Not found", { status: 404 });
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`ValOS desk ${root} on http://${host}:${port}`);
