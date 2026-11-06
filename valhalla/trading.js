import { jupiterBuildUrl, parseBuild } from "./jupiter-v2.js";
import { serviceOrigin } from "./origins.js";
import { reviewTransaction } from "./tx.js";

export var SOL_MINT = "So11111111111111111111111111111111111111112";
export var USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function baseUnits(text, decimals) {
  var raw = String(text || "").trim();
  var places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 9) return { ok: false, reason: "decimals" };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, reason: "amount" };
  var parts = raw.split(".");
  var frac = parts[1] || "";
  if (frac.length > places) return { ok: false, reason: "amount" };
  while (frac.length < places) frac += "0";
  var combined = (parts[0] + frac).replace(/^0+/, "");
  if (!/^[1-9]\d{0,17}$/.test(combined)) return { ok: false, reason: "amount" };
  return { ok: true, amount: combined };
}

export function tradingReady(site, pageHost) {
  if (!site || site.TRADING_ENABLED !== true) return false;
  return Boolean(serviceOrigin(site.AGENT_API_URL, pageHost));
}

export function quoteRequest(site, token, query, pageHost) {
  if (!site || site.TRADING_ENABLED !== true) return { ok: false, reason: "disabled" };
  var base = serviceOrigin(site && site.AGENT_API_URL, pageHost);
  if (!token || !base) return { ok: false, reason: "unconfigured" };
  var planned = jupiterBuildUrl(query);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  var remote = new URL(planned.href);
  var url = new URL(base + "/api/jupiter/quote");
  remote.searchParams.forEach(function (value, key) {
    url.searchParams.set(key, value);
  });
  return {
    ok: true,
    url: url.toString(),
    method: "GET",
    credentials: "omit",
    headers: { authorization: "Bearer " + token, accept: "application/json" },
  };
}

export function emptyQuote() {
  return {
    quoted: false,
    inAmount: "",
    outAmount: "",
    slippageBps: "",
    priceImpactPct: "",
    routes: [],
    note: "Unavailable",
  };
}

export function quoteView(body) {
  var parsed = parseBuild(body);
  if (!parsed.ok || parsed.signed !== false || parsed.tx != null || parsed.executed !== false) return emptyQuote();
  var routes = [];
  (parsed.routePlan || []).forEach(function (hop) {
    var label = hop && hop.swapInfo && typeof hop.swapInfo.label === "string" ? hop.swapInfo.label : "";
    if (label) routes.push(label);
  });
  return {
    quoted: true,
    inAmount: parsed.inAmount,
    outAmount: parsed.outAmount,
    slippageBps: parsed.slippageBps == null ? "" : String(parsed.slippageBps),
    priceImpactPct: parsed.priceImpactPct || "",
    routes: routes,
    note: routes.length ? routes.join(" → ") : "Unavailable",
  };
}

export function signPlan(bytes, taker) {
  var review = reviewTransaction(bytes, taker);
  if (!review.ok) return review;
  if (review.signed) return { ok: false, reason: "already-signed" };
  return { ok: true, action: "signTransaction", signerCount: 1, send: false };
}

export function submitRequest() {
  return { ok: false, reason: "unmounted", sent: false };
}

export function explainPayload(view) {
  if (!view || view.quoted !== true) return null;
  return {
    text: JSON.stringify({
      inAmount: view.inAmount,
      outAmount: view.outAmount,
      slippageBps: view.slippageBps,
      routes: view.routes,
    }),
    capability: "reasoning",
    app: "trading",
    tool: "none",
  };
}
