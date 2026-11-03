/** Public price proxy. No API keys. Cache about 15 seconds. */
var cache = { at: 0, body: null };
var SOL = "So11111111111111111111111111111111111111112";

async function jupiter() {
  var response = await fetch("https://lite-api.jup.ag/price/v2?ids=" + SOL);
  if (!response.ok) throw new Error("jupiter");
  var body = await response.json();
  var row = body.data && body.data[SOL];
  var price = Number(row && row.price);
  if (!price) throw new Error("jupiter price");
  return price;
}

async function gecko() {
  var response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true");
  if (!response.ok) throw new Error("gecko");
  var body = await response.json();
  return { usd: Number(body.solana.usd), change24h: Number(body.solana.usd_24h_change) || 0 };
}

async function trending() {
  var response = await fetch("https://api.dexscreener.com/token-boosts/top/v1");
  if (!response.ok) return [];
  var rows = await response.json();
  var list = (Array.isArray(rows) ? rows : []).filter(function (row) { return row.chainId === "solana" && row.tokenAddress; }).slice(0, 8);
  if (!list.length) return [];
  var addresses = list.map(function (row) { return row.tokenAddress; }).join(",");
  var pairsResponse = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + addresses);
  if (!pairsResponse.ok) return [];
  var pairsBody = await pairsResponse.json();
  var seen = {};
  return (pairsBody.pairs || []).filter(function (pair) {
    if (pair.chainId !== "solana" || seen[pair.baseToken.address]) return false;
    seen[pair.baseToken.address] = true;
    return true;
  }).slice(0, 8).map(function (pair) {
    var liq = Number(pair.liquidity && pair.liquidity.usd) || 0;
    return {
      symbol: String(pair.baseToken.symbol || "TOKEN").slice(0, 12),
      price: Number(pair.priceUsd) || 0,
      change24h: Number(pair.priceChange && pair.priceChange.h24) || 0,
      badge: liq >= 20000 ? "Liq" : "Thin"
    };
  });
}

export default {
  async fetch() {
    if (cache.body && Date.now() - cache.at < 15000) {
      return Response.json(cache.body, { headers: { "cache-control": "public, max-age=15", "access-control-allow-origin": "https://valhalla-app.xyz" } });
    }
    var sol = { usd: 0, change24h: 0, source: "" };
    try {
      sol.usd = await jupiter();
      sol.source = "Jupiter";
    } catch (err) {
      sol.source = "";
    }
    try {
      var fallback = await gecko();
      if (!sol.usd) sol.usd = fallback.usd;
      sol.change24h = fallback.change24h;
      sol.source = sol.source ? sol.source + ", CoinGecko" : "CoinGecko";
    } catch (err) {
      if (!sol.usd) return Response.json({ unavailable: true }, { status: 503 });
    }
    var tokens = [];
    try { tokens = await trending(); } catch (err) { tokens = []; }
    cache.body = { sol: sol, tokens: tokens, sources: sol.source + (tokens.length ? ", DexScreener" : ""), at: Date.now() };
    cache.at = Date.now();
    return Response.json(cache.body, { headers: { "cache-control": "public, max-age=15", "access-control-allow-origin": "https://valhalla-app.xyz" } });
  }
};
