import { SOL_MINT, USDC_MINT, baseUnits, bindQuote, emptyQuote, quoteRequest, quoteSnapshot, submitRequest, tradingReady, VALHALLA_QUOTE_REVIEW_MS } from "./trading.js";
import { challengeRequest, readChallenge, walletId } from "./wallets.js";

var inputMint = document.getElementById("trading-input");
var outputMint = document.getElementById("trading-output");
var amount = document.getElementById("trading-amount");
var decimals = document.getElementById("trading-decimals");
var slippage = document.getElementById("trading-slippage");
var tail = document.getElementById("trading-tail");
var status = document.getElementById("trading-status");
var quoteButton = document.getElementById("trading-quote");
var signButton = document.getElementById("trading-sign");
var walletButton = document.getElementById("trading-wallet");
var walletList = document.getElementById("trading-wallets");
var watchList = document.getElementById("trading-watch");
var watchMint = document.getElementById("trading-watch-mint");
var note = document.getElementById("trading-note");
var notePane = document.getElementById("trading-note-pane");
var noteToggle = document.getElementById("trading-note-toggle");
var inNode = document.getElementById("trading-in");
var outNode = document.getElementById("trading-out");
var impactNode = document.getElementById("trading-impact");
var routeNode = document.getElementById("trading-routes");
var solscan = document.getElementById("trading-solscan");
var addressNode = document.getElementById("trading-address");

var wallets = [];
var connected = "";
var quoteSeq = 0;
var quoteAbort = null;
var quoteTimer = 0;

function fixture() {
  var host = location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return false;
  return new URLSearchParams(location.search).get("fixture") === "preview";
}

function paint(view) {
  var next = view || emptyQuote();
  if (inNode) inNode.textContent = next.inAmount;
  if (outNode) outNode.textContent = next.outAmount;
  if (impactNode) impactNode.textContent = next.priceImpactPct;
  if (routeNode) routeNode.textContent = next.routes.join(", ");
  if (note) note.textContent = next.note;
}

function setStatus(text) {
  if (status) status.textContent = text;
}

function rememberTail() {
  if (!tail) return;
  try { localStorage.setItem("valhalla-wallet-tail", tail.value); } catch (error) { tail.value = tail.value; }
}

if (tail) {
  try { tail.value = localStorage.getItem("valhalla-wallet-tail") || ""; } catch (error) { tail.value = ""; }
  tail.addEventListener("change", rememberTail);
}

function onRegister(event) {
  if (typeof event.detail !== "function") return;
  event.detail(Object.freeze({
    register: function (wallet) {
      if (!walletId(wallet && wallet.name)) return;
      var features = wallet.features || {};
      var connect = features["standard:connect"] && typeof features["standard:connect"].connect === "function";
      if (!connect || wallets.indexOf(wallet) >= 0) return;
      wallets.push(wallet);
    },
  }));
}
window.addEventListener("wallet-standard:register-wallet", onRegister);

function refreshWallets() {
  window.dispatchEvent(new Event("wallet-standard:app-ready"));
  if (!walletList) return;
  walletList.textContent = "";
  if (!wallets.length) {
    var empty = document.createElement("li");
    empty.textContent = "No Wallet Standard wallet is available in this tab.";
    walletList.appendChild(empty);
    return;
  }
  wallets.forEach(function (wallet) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "classic-button";
    button.textContent = wallet.name || "Wallet";
    button.addEventListener("click", function () { void connectWallet(wallet); });
    item.appendChild(button);
    walletList.appendChild(item);
  });
}

async function connectWallet(wallet) {
  var feature = wallet.features && wallet.features["standard:connect"];
  if (!feature || typeof feature.connect !== "function") {
    setStatus("That wallet does not offer a standard connection. Nothing was signed.");
    return;
  }
  try {
    var result = await feature.connect.call(feature);
    var accounts = (result && result.accounts) || wallet.accounts || [];
    var account = accounts[0];
    var address = account && typeof account.address === "string" ? account.address : "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      setStatus("The wallet did not return a public address. Nothing was signed.");
      return;
    }
    connected = address;
    invalidateQuote();
    if (addressNode) addressNode.textContent = "…" + address.slice(-4);
    setStatus("Wallet connected for a public address only. No transaction was requested.");
  } catch (error) {
    setStatus("The wallet connection was not completed. Nothing was signed.");
  }
}

if (walletButton) walletButton.addEventListener("click", refreshWallets);

var linkButton = document.getElementById("trading-link");
if (linkButton) {
  linkButton.addEventListener("click", async function () {
    if (!connected) {
      setStatus("Connect Solflare or MetaMask first. Nothing was signed.");
      return;
    }
    var call = challengeRequest(window.VALHALLA_SITE || {}, connected, location.hostname);
    if (!call) {
      setStatus("Wallet linking is being verified. Nothing was signed.");
      return;
    }
    try {
      var response = await fetch(call.url, {
        method: call.method,
        credentials: call.credentials,
        headers: call.headers,
        body: call.body,
      });
      var body = await response.json().catch(function () { return {}; });
      var challenge = readChallenge(response.status, body, connected);
      if (!challenge.ok) {
        setStatus("Wallet linking is being verified. HTTP " + response.status + ". Nothing was signed.");
        return;
      }
      setStatus(challenge.message);
    } catch (error) {
      setStatus("Wallet linking is being verified. Nothing was signed.");
    }
  });
}

function selectedMint(node, fallback) {
  return (node && node.value.trim()) || fallback;
}

function invalidateQuote() {
  quoteSeq += 1;
  if (quoteAbort) quoteAbort.abort();
  quoteAbort = null;
  if (quoteTimer) window.clearTimeout(quoteTimer);
  quoteTimer = 0;
  paint(emptyQuote());
  if (solscan) {
    solscan.hidden = true;
    solscan.removeAttribute("href");
    solscan.textContent = "";
  }
}

async function requestQuote() {
  invalidateQuote();
  var seq = quoteSeq;
  if (fixture()) {
    setStatus("Fixture — not a live quote.");
    return;
  }
  var units = baseUnits(amount && amount.value, decimals && decimals.value);
  if (!units.ok) {
    setStatus("Enter a base-unit amount. Nothing was requested.");
    return;
  }
  if (!connected || !tail || tail.value !== connected.slice(-4)) {
    setStatus("Confirm the last 4 characters of the connected wallet. Nothing was requested.");
    return;
  }
  var token = "";
  try { token = sessionStorage.getItem("valhalla-auth-token") || ""; } catch (error) { token = ""; }
  var call = quoteRequest(window.VALHALLA_SITE || {}, token, {
    inputMint: selectedMint(inputMint, SOL_MINT),
    outputMint: selectedMint(outputMint, USDC_MINT),
    amount: units.amount,
    taker: connected,
    slippageBps: slippage ? slippage.value : "",
  }, location.hostname);
  if (!call.ok) {
    setStatus(call.reason === "disabled" || call.reason === "unconfigured"
      ? "Quotes are not configured. Public RPC readiness is not claimed."
      : "The quote was not requested. " + call.reason);
    return;
  }
  var snapshot = quoteSnapshot({
    inputMint: selectedMint(inputMint, SOL_MINT),
    outputMint: selectedMint(outputMint, USDC_MINT),
    amount: units.amount,
    taker: connected,
    slippageBps: slippage ? slippage.value : "",
    cluster: "mainnet-beta",
  });
  quoteAbort = new AbortController();
  var receivedMono = window.performance && window.performance.now ? window.performance.now() : Date.now();
  setStatus("Requesting a quote.");
  try {
    var response = await fetch(call.url, {
      method: call.method,
      credentials: call.credentials,
      headers: call.headers,
      signal: quoteAbort.signal,
    });
    if (seq !== quoteSeq) return;
    var body = await response.json().catch(function () { return {}; });
    if (seq !== quoteSeq) return;
    if (response.status === 503 || response.status === 502 || !response.ok) {
      paint(emptyQuote());
      setStatus("The quote service is not ready. No numbers were returned.");
      return;
    }
    var bound = bindQuote(snapshot, body, {
      receivedMono: receivedMono,
      nowMono: window.performance && window.performance.now ? window.performance.now() : Date.now(),
      nowWall: Date.now(),
    });
    if (!bound.ok || bound.signable !== false) {
      paint(emptyQuote());
      setStatus("The quote did not match this request. No numbers are shown.");
      return;
    }
    paint(bound.view);
    var freshNode = document.getElementById("trading-freshness");
    if (freshNode) freshNode.textContent = bound.freshness;
    setStatus(bound.freshness + " Signing is off. A /build result is not a transaction.");
    quoteTimer = window.setTimeout(function () {
      if (seq !== quoteSeq) return;
      invalidateQuote();
      setStatus("Expired under the ValhallaOS 30-second review policy. This is not a Jupiter time-to-live.");
    }, VALHALLA_QUOTE_REVIEW_MS);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    if (seq !== quoteSeq) return;
    setStatus("The quote service could not be reached. No numbers are shown.");
  }
}

if (quoteButton) quoteButton.addEventListener("click", function () { void requestQuote(); });

if (signButton) {
  signButton.disabled = true;
  signButton.addEventListener("click", function () {
    var submit = submitRequest();
    if (!submit.ok) {
      setStatus("Connecting services… The server has no submit route yet. Nothing was signed.");
    }
  });
}

if (noteToggle && notePane) {
  noteToggle.addEventListener("click", function () {
    var open = notePane.hidden;
    notePane.hidden = !open;
    noteToggle.setAttribute("aria-expanded", String(open));
  });
}

var swap = document.getElementById("trading-swap");
if (swap && inputMint && outputMint) {
  swap.addEventListener("click", function () {
    var from = inputMint.value;
    inputMint.value = outputMint.value;
    outputMint.value = from;
    invalidateQuote();
    setStatus("The pair was swapped. No quote was requested.");
  });
}

function renderWatch() {
  if (!watchList) return;
  watchList.textContent = "";
  var saved = [];
  try { saved = JSON.parse(localStorage.getItem("valhalla-watchlist") || "[]"); } catch (error) { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  saved.forEach(function (mint) {
    var item = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "classic-button";
    button.textContent = String(mint).slice(0, 4) + "…" + String(mint).slice(-4);
    button.addEventListener("click", function () {
      if (outputMint) outputMint.value = mint;
      invalidateQuote();
    });
    item.appendChild(button);
    watchList.appendChild(item);
  });
}

var watchAdd = document.getElementById("trading-watch-add");
if (watchAdd) {
  watchAdd.addEventListener("click", function () {
    var mint = watchMint ? watchMint.value.trim() : "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      setStatus("That mint was not saved.");
      return;
    }
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem("valhalla-watchlist") || "[]"); } catch (error) { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    if (saved.indexOf(mint) < 0) saved.push(mint);
    try { localStorage.setItem("valhalla-watchlist", JSON.stringify(saved.slice(0, 12))); } catch (error) { saved = saved; }
    renderWatch();
  });
}

document.querySelectorAll("[data-mint]").forEach(function (button) {
  button.addEventListener("click", function () {
    var target = document.getElementById(button.getAttribute("data-mint-target"));
    if (target) target.value = button.getAttribute("data-mint");
    invalidateQuote();
  });
});

if (fixture() && quoteButton) {
  quoteButton.disabled = true;
  quoteButton.textContent = "Get quote";
  setStatus("Fixture — not a live quote. Public RPC readiness is not claimed.");
} else if (quoteButton) {
  quoteButton.textContent = "Get quote";
  if (!tradingReady(window.VALHALLA_SITE || {})) {
    quoteButton.disabled = true;
    setStatus("Quotes are not configured. Public RPC readiness is not claimed.");
  }
}
[inputMint, outputMint, amount, decimals, slippage].forEach(function (node) {
  if (!node) return;
  node.addEventListener("input", function () { invalidateQuote(); });
});

paint(emptyQuote());
renderWatch();
refreshWallets();
