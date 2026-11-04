/**
 * Hourly self-repair. Cron only.
 * It never deploys code, never reads secret values into a report, and never moves funds.
 * Optional env: REPAIR_KV, ADMIN_WALLETS, AUTH_HEALTH_URL, TICKER_HEALTH_URL,
 * CHAT_HEALTH_URL, PAY_HEALTH_URL, STATUS_HEALTH_URL, SENTRY_DSN, INCIDENT_EMAIL_URL.
 * SENTRY_DSN stays empty unless you choose Sentry's free tier.
 */
import { actionFor, alertFor } from "./repair-logic.js";

var NAMES = ["VALHALLA CORE", "MECHA BRAIN", "ASK VALHALLA", "ODIN FEED", "FORGE LAB", "HEIMDALL GATE", "SENTINEL WATCH"];

function stateOf(check) {
  if (check === "up") return "LIVE";
  if (check === "down") return "OFFLINE";
  return "DEGRADED";
}

function statusHeaders(request) {
  var headers = new Headers({ "cache-control": "no-store" });
  var origin = request.headers.get("origin") || "";
  if (origin === "https://valhalla-app.xyz" || origin === "https://www.valhalla-app.xyz") {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return headers;
}

async function probe(url) {
  if (!url) return "unknown";
  try {
    var response = await fetch(url, { method: "GET" });
    if (response.ok) return "up";
    return "down";
  } catch (err) {
    return "down";
  }
}

async function sentry(env, text) {
  if (!env.SENTRY_DSN) return;
  await fetch(env.SENTRY_DSN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: String(text).slice(0, 200) })
  }).catch(function () {});
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (url.pathname === "/status") {
      var pub = env.REPAIR_KV ? await env.REPAIR_KV.get("status:public") : "";
      var headers = statusHeaders(request);
      if (!pub) return Response.json({ unavailable: true }, { status: 503, headers: headers });
      return Response.json(JSON.parse(pub), { headers: headers });
    }
    if (url.pathname === "/signals") {
      var restart = env.REPAIR_KV ? await env.REPAIR_KV.get("paper:restart") : "";
      var llm = env.REPAIR_KV ? await env.REPAIR_KV.get("llm:provider") : "";
      return Response.json({ paperRestart: restart === "1", llm: llm === "backup" ? "backup" : "primary" });
    }
    if (url.pathname === "/log" && request.method === "POST") {
      if (!env.REPAIR_KV) return Response.json({ ok: false }, { status: 503 });
      var body = await request.json().catch(function () { return {}; });
      var logs = JSON.parse((await env.REPAIR_KV.get("logs")) || "[]");
      logs.unshift({ at: Date.now(), code: String(body.code || "V-1").slice(0, 16), detail: String(body.detail || "").slice(0, 300) });
      await env.REPAIR_KV.put("logs", JSON.stringify(logs.slice(0, 80)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/report" && request.method === "POST") {
      if (!env.ADMIN_WALLETS) return Response.json({ ok: false }, { status: 503 });
      var proof = await request.json().catch(function () { return {}; });
      var allow = String(env.ADMIN_WALLETS).split(",").map(function (item) { return item.trim(); });
      if (allow.indexOf(String(proof.pubkey || "")) < 0) return Response.json({ ok: false }, { status: 403 });
      var report = env.REPAIR_KV ? await env.REPAIR_KV.get("report:leader") : "";
      if (!report) return Response.json({ ok: true, text: "No hourly report yet.", proposals: [] });
      return Response.json(JSON.parse(report));
    }
    if (url.pathname === "/decide" && request.method === "POST") {
      if (!env.ADMIN_WALLETS || !env.REPAIR_KV) return Response.json({ ok: false }, { status: 503 });
      var decision = await request.json().catch(function () { return {}; });
      var allow = String(env.ADMIN_WALLETS).split(",").map(function (item) { return item.trim(); });
      if (allow.indexOf(String(decision.pubkey || "")) < 0) return Response.json({ ok: false }, { status: 403 });
      var report = JSON.parse((await env.REPAIR_KV.get("report:leader")) || "{\"proposals\":[]}");
      (report.proposals || []).forEach(function (item) {
        if (item.id === decision.id) item.status = decision.action === "approve" ? "approved" : "rejected";
      });
      report.note = "Approval is recorded. No code was deployed.";
      await env.REPAIR_KV.put("report:leader", JSON.stringify(report));
      return Response.json({ ok: true, note: report.note });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  }
};

async function run(env) {
  if (!env.REPAIR_KV) return;
  var checks = {
    auth: await probe(env.AUTH_HEALTH_URL),
    ticker: await probe(env.TICKER_HEALTH_URL),
    chat: await probe(env.CHAT_HEALTH_URL),
    pay: await probe(env.PAY_HEALTH_URL),
    status: await probe(env.STATUS_HEALTH_URL)
  };
  var logs = JSON.parse((await env.REPAIR_KV.get("logs")) || "[]");
  var fixes = [];
  var proposals = JSON.parse((await env.REPAIR_KV.get("proposals")) || "[]");
  var streaks = JSON.parse((await env.REPAIR_KV.get("streaks")) || "{}");
  Object.keys(checks).forEach(function (name) {
    streaks[name] = checks[name] === "down" ? Number(streaks[name] || 0) + 1 : 0;
  });
  var blob = logs.map(function (row) { return row.code + " " + row.detail; }).join("\n");
  var action = actionFor(blob);
  if (action === "clear-cache") {
    await env.REPAIR_KV.delete("ticker:cache");
    fixes.push("Cleared the price cache.");
  } else if (action === "rotate-llm") {
    await env.REPAIR_KV.put("llm:provider", "backup");
    fixes.push("Pointed chat at the backup model flag.");
  } else if (action === "restart-paper") {
    await env.REPAIR_KV.put("paper:restart", "1");
    fixes.push("Asked open desks to restart the paper bot.");
  } else if (action === "requeue") {
    var failed = JSON.parse((await env.REPAIR_KV.get("jobs:failed")) || "[]");
    var queue = JSON.parse((await env.REPAIR_KV.get("jobs:queue")) || "[]");
    await env.REPAIR_KV.put("jobs:queue", JSON.stringify(queue.concat(failed).slice(0, 40)));
    await env.REPAIR_KV.put("jobs:failed", "[]");
    fixes.push("Re-queued failed jobs.");
  } else if (action === "propose") {
    proposals.unshift({ id: "p-" + Date.now(), text: "A log asked for a code or config change. Review it. Nothing was deployed.", status: "pending" });
  }
  var alerts = Object.keys(streaks).filter(function (name) { return alertFor(streaks[name]); }).map(function (name) {
    return name + " failed 3 hours in a row.";
  });
  if (alerts.length && env.INCIDENT_EMAIL_URL) {
    await fetch(env.INCIDENT_EMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alerts.join(" ") })
    }).catch(function () {});
    await sentry(env, alerts.join(" "));
  }
  var degraded = Object.keys(checks).some(function (name) { return checks[name] !== "up"; });
  var lines = [
    { name: "VALHALLA CORE", state: stateOf(checks.status) },
    { name: "MECHA BRAIN", state: stateOf(checks.chat) },
    { name: "ASK VALHALLA", state: stateOf(checks.chat) },
    { name: "ODIN FEED", state: stateOf(checks.ticker) },
    { name: "FORGE LAB", state: "DEGRADED" },
    { name: "HEIMDALL GATE", state: stateOf(checks.auth) },
    { name: "SENTINEL WATCH", state: stateOf(checks.status) }
  ];
  if (lines.some(function (line) { return !NAMES.includes(line.name); })) return;
  await env.REPAIR_KV.put("status:public", JSON.stringify({
    overall: degraded ? "SYSTEMS DEGRADED" : "ALL SYSTEMS LIVE",
    checkedAt: Date.now(),
    lines: lines
  }));
  await env.REPAIR_KV.put("streaks", JSON.stringify(streaks));
  await env.REPAIR_KV.put("proposals", JSON.stringify(proposals.slice(0, 12)));
  await env.REPAIR_KV.put("report:leader", JSON.stringify({
    at: new Date().toISOString(),
    fixes: fixes,
    alerts: alerts,
    proposals: proposals.slice(0, 12),
    text: "Hourly check finished. No code was deployed."
  }));
}
