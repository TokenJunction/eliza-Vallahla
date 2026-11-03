/**
 * Hive coordinator. Jobs are public prices and strategy settings only.
 * ADMIN_WALLETS and TURNSTILE_SECRET stay in Cloudflare secrets.
 * This worker does not move funds.
 */
var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz", "https://tokenjunction.github.io"];
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function cors(request) {
  var origin = request.headers.get("Origin") || "";
  var allow = ALLOWED.indexOf(origin) >= 0 ? origin : ALLOWED[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function b58(text) {
  var bytes = [0];
  for (var i = 0; i < text.length; i += 1) {
    var value = ALPHABET.indexOf(text[i]);
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

export function majority(rows) {
  var groups = {};
  (rows || []).forEach(function (row) {
    if (!row || !Number.isFinite(Number(row.cash)) || !Number.isFinite(Number(row.n))) return;
    var key = Number(row.cash) + ":" + Number(row.n);
    groups[key] = groups[key] || [];
    groups[key].push(row);
  });
  var best = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; })[0];
  if (!best || groups[best].length < 2) return null;
  return { cash: Number(best.split(":")[0]), n: Number(best.split(":")[1]), votes: groups[best].length };
}

function sampleJob() {
  return {
    id: "public-sol-sample",
    simulated: true,
    series: [100, 101, 100.4, 99.2, 100.1, 100.8],
    params: { stopPct: 15, takePct: 30, size: 0.05 }
  };
}

async function leader(request, env) {
  var allow = String(env.ADMIN_WALLETS || "").split(",").map(function (item) { return item.trim(); }).filter(Boolean);
  if (!allow.length) return false;
  var body = await request.clone().json().catch(function () { return null; });
  if (!body || allow.indexOf(String(body.pubkey || "")) < 0) return false;
  var message = String(body.message || "");
  if (message.indexOf("valhalla-app.xyz") < 0 || message.indexOf("Hive flag") < 0) return false;
  var stamp = Date.parse((message.match(/Expires: (.+)/) || [])[1] || "");
  if (!Number.isFinite(stamp) || stamp < Date.now()) return false;
  var pub = b58(String(body.pubkey || ""));
  var sig = Uint8Array.from(atob(String(body.signature || "")), function (char) { return char.charCodeAt(0); });
  if (pub.length !== 32 || sig.length !== 64) return false;
  var key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(message));
}

export class HiveRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
  }

  async fetch(request) {
    var url = new URL(request.url);
    var headers = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: headers });
    if (url.pathname === "/hive/public") {
      var enabled = (await this.state.storage.get("enabled")) === true;
      var seen = (await this.state.storage.get("seen")) || {};
      var now = Date.now();
      var nodes = Object.keys(seen).filter(function (id) { return now - seen[id] < 120000; }).length;
      return Response.json({ enabled: enabled, nodes: nodes }, { headers: headers });
    }
    var enabled = (await this.state.storage.get("enabled")) === true;
    if (url.pathname === "/hive/flag" && request.method === "POST") {
      if (!(await leader(request, this.env))) {
        return Response.json({ ok: false }, { status: 403, headers: headers });
      }
      var flag = await request.json();
      await this.state.storage.put("enabled", flag.enabled === true);
      return Response.json({ ok: true, enabled: flag.enabled === true }, { headers: headers });
    }
    if (!enabled) return Response.json({ enabled: false }, { status: 403, headers: headers });
    if (url.pathname === "/hive/join" && request.method === "POST") {
      var join = await request.json();
      var secret = this.env.TURNSTILE_SECRET;
      if (!secret) return Response.json({ ok: false }, { status: 503, headers: headers });
      var form = new URLSearchParams();
      form.set("secret", secret);
      form.set("response", String(join.token || ""));
      var check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
      var verdict = await check.json();
      if (!verdict.success) return Response.json({ ok: false }, { status: 403, headers: headers });
      var nodeId = crypto.randomUUID();
      var seen = (await this.state.storage.get("seen")) || {};
      seen[nodeId] = Date.now();
      await this.state.storage.put("seen", seen);
      return Response.json({ nodeId: nodeId }, { headers: headers });
    }
    if (url.pathname === "/hive/next" && request.method === "POST") {
      var nextBody = await request.json();
      var nodeId = String(nextBody.nodeId || "");
      var seen = (await this.state.storage.get("seen")) || {};
      if (!seen[nodeId]) return Response.json({ ok: false }, { status: 403, headers: headers });
      seen[nodeId] = Date.now();
      await this.state.storage.put("seen", seen);
      var jobs = (await this.state.storage.get("jobs")) || [sampleJob()];
      var job = jobs[0];
      job.assignments = job.assignments || [];
      if (job.assignments.indexOf(nodeId) < 0 && job.assignments.length < 3) job.assignments.push(nodeId);
      await this.state.storage.put("jobs", jobs);
      return Response.json({ id: job.id, series: job.series, params: job.params, simulated: true }, { headers: headers });
    }
    if (url.pathname === "/hive/result" && request.method === "POST") {
      var result = await request.json();
      var nodeId = String(result.nodeId || "");
      var limits = (await this.state.storage.get("limits")) || {};
      var hour = new Date().toISOString().slice(0, 13);
      var bucket = limits[nodeId] || { hour: hour, n: 0 };
      if (bucket.hour !== hour) bucket = { hour: hour, n: 0 };
      if (bucket.n >= 30) return Response.json({ ok: false }, { status: 429, headers: headers });
      bucket.n += 1;
      limits[nodeId] = bucket;
      await this.state.storage.put("limits", limits);
      var jobs = (await this.state.storage.get("jobs")) || [];
      var job = jobs[0];
      if (!job || job.id !== result.jobId) return Response.json({ ok: false }, { status: 404, headers: headers });
      job.results = job.results || [];
      var accountId = String(result.accountId || "").slice(0, 64);
      job.results.push({ nodeId: nodeId, accountId: accountId, cash: Number(result.cash), n: Number(result.n) });
      var agreed = majority(job.results);
      var points = (await this.state.storage.get("points")) || {};
      if (agreed && !job.paid) {
        job.paid = true;
        job.results.forEach(function (row) {
          if (row.accountId && row.cash === agreed.cash && row.n === agreed.n) {
            points[row.accountId] = Number(points[row.accountId] || 0) + 1;
          }
        });
        jobs.shift();
        if (!jobs.length) jobs.push(sampleJob());
      }
      await this.state.storage.put("jobs", jobs);
      await this.state.storage.put("points", points);
      return Response.json({ ok: true, points: Number(points[accountId] || 0), simulated: true }, { headers: headers });
    }
    if (url.pathname === "/rewards/link" && request.method === "POST") {
      return Response.json({ enabled: false, banner: "Rewards are points only for now" }, { status: 403, headers: headers });
    }
    if (url.pathname === "/rewards/approve" && request.method === "POST") {
      return Response.json({ enabled: false }, { status: 403, headers: headers });
    }
    return new Response("Not found", { status: 404, headers: headers });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(request) });
    var url = new URL(request.url);
    if (url.pathname === "/status") {
      var id = env.HIVE.idFromName("hive");
      var room = env.HIVE.get(id);
      var inner = new Request(new URL("/hive/public", request.url), request);
      var pub = await room.fetch(inner);
      var hive = await pub.json();
      return Response.json({
        overall: "Status unavailable",
        checkedAt: Date.now(),
        hive: { enabled: hive.enabled === true, nodes: Number(hive.nodes) || 0 },
        lines: []
      }, { headers: cors(request) });
    }
    var id = env.HIVE.idFromName("hive");
    return env.HIVE.get(id).fetch(request);
  }
};
