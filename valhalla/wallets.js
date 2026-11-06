import { serviceOrigin } from "./origins.js";
import { encodeBase58 } from "./tx.js";

export var WALLET_IDS = ["solflare", "metamask"];

export function walletId(name) {
  var text = String(name || "");
  if (/solflare/i.test(text)) return "solflare";
  if (/metamask/i.test(text)) return "metamask";
  return "";
}

export function discover(input) {
  var found = [];
  function caps(features) {
    return {
      link: Boolean(features && features["solana:signMessage"] && typeof features["solana:signMessage"].signMessage === "function"),
      sign: Boolean(features && features["solana:signTransaction"] && typeof features["solana:signTransaction"].signTransaction === "function"),
      connect: Boolean(features && features["standard:connect"] && typeof features["standard:connect"].connect === "function"),
    };
  }
  function add(id, source, ability) {
    if (WALLET_IDS.indexOf(id) < 0 || !ability.connect) return;
    if (found.some(function (item) { return item.id === id; })) return;
    found.push({ id: id, source: source, link: ability.link === true, sign: ability.sign === true });
  }
  (input && input.standard || []).forEach(function (wallet) {
    var id = walletId(wallet && wallet.name);
    var ability = caps(wallet && wallet.features);
    if (!id) return;
    add(id, "standard", ability);
  });
  var injected = input && input.injected || {};
  var solflare = injected.solflare;
  if (solflare && typeof solflare.connect === "function") {
    add("solflare", "injected", {
      connect: true,
      link: typeof solflare.signMessage === "function",
      sign: typeof solflare.signTransaction === "function",
    });
  }
  var metamask = injected.metamask;
  if (metamask && metamask.isMetaMask === true && metamask.solana && typeof metamask.solana.connect === "function") {
    add("metamask", "injected", {
      connect: true,
      link: typeof metamask.solana.signMessage === "function",
      sign: typeof metamask.solana.signTransaction === "function",
    });
  }
  return {
    wallets: found,
    chooser: found.length > 1,
    only: found.length === 1 ? found[0].id : "",
  };
}

export function installStep(id, options) {
  var pageUrl = options && options.pageUrl || "";
  if (WALLET_IDS.indexOf(id) < 0) return { action: "none" };
  if (options && options.mobile) {
    var browse = id === "solflare"
      ? "https://solflare.com/ul/v1/browse/" + encodeURIComponent(pageUrl)
      : "https://metamask.app.link/dapp/" + encodeURIComponent(pageUrl);
    return { action: "browse", url: browse };
  }
  return {
    action: "install",
    url: id === "solflare" ? "https://solflare.com/download" : "https://metamask.io/download/",
  };
}

export function signFeature(features) {
  var sign = features && features["solana:signTransaction"];
  if (sign && typeof sign.signTransaction === "function") return "solana:signTransaction";
  return "";
}

export function retryDelay(attempt) {
  var step = Math.max(0, Math.min(Number(attempt) || 0, 4));
  return 500 * Math.pow(2, step);
}

export function challengeRequest(site, walletAddress, pageHost) {
  var base = serviceOrigin(site && site.AUTH_URL, pageHost);
  if (!base || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(walletAddress || ""))) return null;
  return {
    url: base + "/auth/wallet/challenge",
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ walletAddress: walletAddress }),
  };
}

export function readChallenge(httpStatus, body, walletAddress, now) {
  var clock = now || Date.now();
  if (!(httpStatus >= 200 && httpStatus < 300) || !body) return { ok: false, reason: "http", code: httpStatus };
  if (typeof body.message !== "string" || !body.message.trim()) return { ok: false, reason: "blank", code: httpStatus };
  if (typeof body.challengeId !== "string" || !body.challengeId) return { ok: false, reason: "challenge", code: httpStatus };
  if (body.message.indexOf(walletAddress) < 0 || body.message.indexOf(body.challengeId) < 0) {
    return { ok: false, reason: "address", code: httpStatus };
  }
  if (body.message.indexOf("ValhallaOS wallet link") < 0) return { ok: false, reason: "text", code: httpStatus };
  var expiry = /expiresAt: (\S+)/.exec(body.message);
  if (!expiry || Number.isNaN(Date.parse(expiry[1])) || Date.parse(expiry[1]) <= clock) {
    return { ok: false, reason: "expiry", code: httpStatus };
  }
  return { ok: true, message: body.message, challengeId: body.challengeId };
}

export function linkBody(message, signatureBytes, walletAddress, challengeId) {
  if (typeof message !== "string" || !message) return null;
  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length !== 64) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(walletAddress || ""))) return null;
  if (!challengeId || message.indexOf(challengeId) < 0) return null;
  return {
    message: message,
    signature: encodeBase58(signatureBytes),
    walletAddress: walletAddress,
    challengeId: challengeId,
  };
}

export function linkResult(httpStatus, body) {
  if (!(httpStatus >= 200 && httpStatus < 300) || !body || body.ok !== true) {
    return { linked: false, leader: false, trade: false, code: httpStatus };
  }
  return { linked: body.linked === true, leader: false, trade: false, code: httpStatus };
}
