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

export function rpcReadiness() {
  return { mounted: false, ready: false, reason: "unmounted" };
}

export var VALHALLA_QUOTE_REVIEW_MS = 30000;

export function quoteSnapshot(query) {
  return {
    inputMint: String(query.inputMint || ""),
    outputMint: String(query.outputMint || ""),
    inAmount: String(query.amount || query.inAmount || ""),
    slippageBps: query.slippageBps == null || query.slippageBps === "" ? "" : String(query.slippageBps),
    taker: String(query.taker || ""),
    cluster: String(query.cluster || "mainnet-beta"),
  };
}

export function quoteFreshness(timing, body) {
  var age = Number(timing && timing.nowMono) - Number(timing && timing.receivedMono);
  if (!(age >= 0) || age >= VALHALLA_QUOTE_REVIEW_MS) {
    return {
      current: false,
      reason: "valhalla-review-window",
      label: "Expired under the ValhallaOS 30-second review policy. This is not a Jupiter time-to-live.",
    };
  }
  var provider = body && (body.expiresAt || body.quoteExpiresAt || body.validUntil);
  if (provider == null || provider === "") {
    return {
      current: true,
      reason: "freshness-not-supplied",
      label: "Freshness not supplied; refreshed review required before signing.",
    };
  }
  var when = Date.parse(provider);
  if (Number.isNaN(when) || when <= Number(timing.nowWall)) {
    return { current: false, reason: "provider-expiry", label: "The provider expiry has passed." };
  }
  return { current: true, reason: "provider-expiry", label: "A provider expiry was supplied. The 30-second limit is ValhallaOS review policy." };
}

export function bindQuote(snapshot, body, timing) {
  var blank = { ok: false, signable: false, view: emptyQuote() };
  var parsed = parseBuild(body);
  if (!parsed.ok) return Object.assign({}, blank, { reason: parsed.reason || "body" });
  if (parsed.inputMint !== snapshot.inputMint) return Object.assign({}, blank, { reason: "inputMint" });
  if (parsed.outputMint !== snapshot.outputMint) return Object.assign({}, blank, { reason: "outputMint" });
  if (String(parsed.inAmount) !== String(snapshot.inAmount)) return Object.assign({}, blank, { reason: "inAmount" });
  var slip = parsed.slippageBps == null ? "" : String(parsed.slippageBps);
  if (slip !== String(snapshot.slippageBps)) return Object.assign({}, blank, { reason: "slippage" });
  var taker = body && (body.taker || body.userPublicKey || "");
  if (String(taker) !== String(snapshot.taker)) return Object.assign({}, blank, { reason: "taker" });
  var cluster = body && (body.cluster || body.network || "");
  if (!cluster || String(cluster) !== String(snapshot.cluster)) return Object.assign({}, blank, { reason: "cluster" });
  var freshness = quoteFreshness(timing, body);
  if (!freshness.current) return Object.assign({}, blank, { reason: freshness.reason, freshness: freshness.label });
  var view = quoteView(body);
  if (!view.quoted) return Object.assign({}, blank, { reason: "body" });
  return { ok: true, reason: "build-not-a-transaction", signable: false, freshness: freshness.label, view: view };
}

export function paintAllowed(seq, current) {
  return seq === current;
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
