/**
 * Cheap always-on keeper for the Valhalla lab.
 * Cron health, a paused paper journal, and config proposals.
 * It does not hold keys, sign, or send real orders.
 * ADMIN_WALLETS, TURNSTILE_SECRET, and any LLM key stay in Cloudflare secrets.
 */
var ALLOWED = ["https://valhalla-app.xyz", "https://www.valhalla-app.xyz"];
var GRID = {
  stopPct: [10, 15, 20],
  takePct: [20, 30],
  sizeSol: [0.05, 0.1]
};
var BOUNDS = { stopPct: [5, 30], takePct: [10, 50], sizeSol: [0.01, 0.5] };
var CAPS = { paperSteps: 200, healthChecks: 300, llmTokens: 5000 };

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

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function used(env, name) {
  var raw = await env.LAB_KV.get("cap:" + dayKey() + ":" + name);
  return Number(raw || 0);
}

async function bump(env, name) {
  var next = (await used(env, name)) + 1;
  await env.LAB_KV.put("cap:" + dayKey() + ":" + name, String(next), { expirationTtl: 172800 });
  return next;
}

async function price(env) {
  var urls = [env.PRICE_URL || "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", env.BACKUP_PRICE_URL].filter(Boolean);
  var last = "price down";
  for (var i = 0; i < urls.length; i += 1) {
    try {
      var response = await fetch(urls[i]);
      if (!response.ok) throw new Error("status " + response.status);
      var body = await response.json();
      var value = body.solana && body.solana.usd;
      if (!Number.isFinite(Number(value))) throw new Error("bad price");
      return Number(value);
    } catch (err) {
      last = err instanceof Error ? err.message : "price failed";
    }
  }
  throw new Error(last);
}

function inBounds(config) {
  return config.stopPct >= BOUNDS.stopPct[0] && config.stopPct <= BOUNDS.stopPct[1]
    && config.takePct >= BOUNDS.takePct[0] && config.takePct <= BOUNDS.takePct[1]
    && config.sizeSol >= BOUNDS.sizeSol[0] && config.sizeSol <= BOUNDS.sizeSol[1];
}

function score(config, series) {
  var cut = Math.max(2, Math.floor(series.length * 0.7));
  function run(slice) {
    var cash = 0;
    var peak = 0;
    var worst = 0;
    for (var i = 1; i < slice.length; i += 1) {
      var move = (slice[i] - slice[i - 1]) / slice[i - 1];
      var gain = move > config.takePct / 100 ? config.takePct / 100 : move;
      var loss = gain < -(config.stopPct / 100) ? -(config.stopPct / 100) : gain;
      cash += loss * config.sizeSol;
      peak = Math.max(peak, cash);
      worst = Math.min(worst, cash - peak);
    }
    return { cash: cash, worst: worst };
  }
  var train = run(series.slice(0, cut));
  var test = run(series.slice(cut));
  var risk = Math.abs(test.worst) || 0.01;
  return { train: train.cash, test: test.cash, score: test.cash / risk };
}

async function propose(env, series) {
  var current = JSON.parse((await env.LAB_KV.get("config:live")) || "{\"stopPct\":15,\"takePct\":25,\"sizeSol\":0.1,\"version\":1}");
  var best = null;
  GRID.stopPct.forEach(function (stopPct) {
    GRID.takePct.forEach(function (takePct) {
      GRID.sizeSol.forEach(function (sizeSol) {
        var config = { stopPct: stopPct, takePct: takePct, sizeSol: sizeSol };
        if (!inBounds(config)) return;
        var result = score(config, series);
        if (!best || result.score > best.result.score) best = { config: config, result: result };
      });
    });
  });
  if (!best) return;
  var baseline = score(current, series);
  if (best.result.score <= baseline.score) return;
  var proposal = {
    id: Date.now().toString(36),
    at: new Date().toISOString(),
    label: "Candidate config",
    simulated: true,
    config: best.config,
    baseline: baseline,
    result: best.result,
    status: "pending"
  };
  await env.LAB_KV.put("proposal:current", JSON.stringify(proposal));
  await incident(env, "Candidate config is waiting for approval. Nothing live changed.");
}

async function incident(env, text) {
  var feed = JSON.parse((await env.LAB_KV.get("feed")) || "[]");
  feed.unshift({ at: new Date().toISOString(), kind: "incident", simulated: true, text: text });
  await env.LAB_KV.put("feed", JSON.stringify(feed.slice(0, 40)));
  if (env.INCIDENT_EMAIL_URL) {
    await fetch(env.INCIDENT_EMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "hello@valhalla-app.xyz", text: text })
    }).catch(function () {});
  }
}

async function health(env) {
  var report = { ok: true, paper: "running", checks: {} };
  try {
    report.checks.price = await price(env);
  } catch (err) {
    report.ok = false;
    report.checks.price = "down";
    var fails = await bump(env, "priceFails");
    if (fails >= 3) {
      await env.LAB_KV.put("paper:paused", "1");
      report.paper = "paused";
      await incident(env, "Price data failed. The simulated paper run is paused. No code was changed.");
    }
  }
  report.caps = {
    paperSteps: await used(env, "paperSteps"),
    healthChecks: await used(env, "healthChecks")
  };
  await env.LAB_KV.put("health:last", JSON.stringify(report));
  await publishStatus(env, report);
  return report;
}

async function publishStatus(env, report) {
  var book = JSON.parse((await env.LAB_KV.get("uptime")) || "{}");
  var day = dayKey();
  book[day] = book[day] || { ok: 0, n: 0 };
  book[day].n += 1;
  if (report.ok) book[day].ok += 1;
  var days = Object.keys(book).sort().slice(-7);
  var kept = {};
  days.forEach(function (key) { kept[key] = book[key]; });
  await env.LAB_KV.put("uptime", JSON.stringify(kept));
  var ok = 0;
  var n = 0;
  days.forEach(function (key) { ok += kept[key].ok; n += kept[key].n; });
  var brain = await probe(env.BRAIN_HEALTH_URL);
  var chat = await probe(env.CHAT_HEALTH_URL);
  var gate = await probe("https://valhalla-turnstile-verify.valhalla-app.workers.dev/api/verify");
  var lines = [
    { name: "VALHALLA CORE", state: "LIVE" },
    { name: "MECHA BRAIN", state: brain },
    { name: "ASK VALHALLA", state: chat },
    { name: "ODIN FEED", state: report.checks && report.checks.price === "down" ? "OFFLINE" : report.ok ? "LIVE" : "DEGRADED" },
    { name: "FORGE LAB", state: report.paper === "running" ? "LIVE" : report.paper === "paused" ? "DEGRADED" : "OFFLINE", note: "simulated" },
    { name: "HEIMDALL GATE", state: gate },
    { name: "SENTINEL WATCH", state: "LIVE" }
  ];
  var offline = lines.some(function (line) { return line.state === "OFFLINE"; });
  var degraded = lines.some(function (line) { return line.state === "DEGRADED"; });
  var overall = offline ? "SYSTEMS OFFLINE" : degraded ? "SYSTEMS DEGRADED" : "ALL SYSTEMS LIVE";
  await env.LAB_KV.put("status:public", JSON.stringify({
    overall: overall,
    uptime7d: n ? Math.round((1000 * ok) / n) / 10 : 0,
    checkedAt: Date.now(),
    lines: lines
  }));
}

async function probe(url) {
  if (!url) return "OFFLINE";
  try {
    var response = await fetch(url, { method: "GET" });
    if (response.ok || response.status === 204 || response.status === 405) return "LIVE";
    return "DEGRADED";
  } catch (err) {
    return "OFFLINE";
  }
}

async function paperStep(env) {
  if (await env.LAB_KV.get("paper:paused") === "1") return;
  if (await used(env, "paperSteps") >= CAPS.paperSteps) {
    await incident(env, "Daily simulated step cap reached. The paper run is waiting.");
    return;
  }
  var mark = 0;
  try { mark = await price(env); } catch (err) { return; }
  await bump(env, "paperSteps");
  var feed = JSON.parse((await env.LAB_KV.get("feed")) || "[]");
  feed.unshift({
    at: new Date().toISOString(),
    kind: "paper",
    simulated: true,
    text: "SIMULATED mark " + mark.toFixed(2) + ". No order was sent."
  });
  await env.LAB_KV.put("feed", JSON.stringify(feed.slice(0, 40)));
  var series = JSON.parse((await env.LAB_KV.get("series")) || "[]");
  series.push(mark);
  await env.LAB_KV.put("series", JSON.stringify(series.slice(-48)));
  if (series.length >= 12 && series.length % 12 === 0) await propose(env, series.slice(-48));
}

async function handle(request, env) {
  var headers = cors(request);
  if (request.method === "OPTIONS") return new Response(null, { headers: headers });
  var url = new URL(request.url);
  if (url.pathname === "/status") {
    var pub = await env.LAB_KV.get("status:public");
    if (!pub) return Response.json({ unavailable: true }, { status: 503, headers: headers });
    return Response.json(JSON.parse(pub), { headers: headers });
  }
  if (url.pathname === "/health") {
    await bump(env, "healthChecks");
    var last = await env.LAB_KV.get("health:last");
    return Response.json(last ? JSON.parse(last) : { ok: false, paper: "unknown" }, { headers: headers });
  }
  if (url.pathname === "/lab/feed") {
    return Response.json({ simulated: true, items: JSON.parse((await env.LAB_KV.get("feed")) || "[]") }, { headers: headers });
  }
  if (url.pathname === "/lab/proposal") {
    return Response.json({ simulated: true, proposal: JSON.parse((await env.LAB_KV.get("proposal:current")) || "null") }, { headers: headers });
  }
  if (request.method === "POST" && url.pathname === "/lab/decision") {
    var body = await request.json();
    var proposal = JSON.parse((await env.LAB_KV.get("proposal:current")) || "null");
    if (!proposal || body.id !== proposal.id) return Response.json({ ok: false }, { status: 404, headers: headers });
    if (body.action === "approve") {
      var live = JSON.parse((await env.LAB_KV.get("config:live")) || "{\"version\":0}");
      var history = JSON.parse((await env.LAB_KV.get("config:history")) || "[]");
      history.unshift(live);
      proposal.config.version = (live.version || 0) + 1;
      proposal.config.simulated = true;
      await env.LAB_KV.put("config:live", JSON.stringify(proposal.config));
      await env.LAB_KV.put("config:history", JSON.stringify(history.slice(0, 12)));
      proposal.status = "approved";
    } else {
      proposal.status = "rejected";
    }
    await env.LAB_KV.put("proposal:current", JSON.stringify(proposal));
    await incident(env, "Candidate config " + proposal.status + ". Simulated only.");
    return Response.json({ ok: true, simulated: true, status: proposal.status }, { headers: headers });
  }
  if (request.method === "POST" && url.pathname === "/lab/rollback") {
    var history = JSON.parse((await env.LAB_KV.get("config:history")) || "[]");
    var previous = history.shift();
    if (!previous) return Response.json({ ok: false }, { status: 404, headers: headers });
    await env.LAB_KV.put("config:live", JSON.stringify(previous));
    await env.LAB_KV.put("config:history", JSON.stringify(history));
    await incident(env, "Config rolled back. Simulated only.");
    return Response.json({ ok: true, simulated: true }, { headers: headers });
  }
  return new Response("Not found", { status: 404, headers: headers });
}

export default {
  async fetch(request, env) {
    if (!env.LAB_KV) return Response.json({ ok: false, error: "LAB_KV is not bound" }, { status: 500, headers: cors(request) });
    return handle(request, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(health(env).then(function () { return paperStep(env); }));
  }
};
