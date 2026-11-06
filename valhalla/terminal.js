import { SOL_MINT, USDC_MINT, baseUnits, emptyQuote, quoteRequest, quoteView, submitRequest, tradingReady } from "./trading.js";
import { challengeRequest, readChallenge } from "./wallets.js";

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
      if (wallet && wallets.indexOf(wallet) < 0) wallets.push(wallet);
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
    if (addressNode) addressNode.textContent = "…" + address.slice(-4);
    setStatus("Wallet connected. No transaction was requested.");
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

function clearQuote() {
  paint(emptyQuote());
  if (solscan) {
    solscan.hidden = true;
    solscan.removeAttribute("href");
    solscan.textContent = "";
  }
}

async function requestQuote() {
  clearQuote();
  if (fixture()) {
    setStatus("Preview fixture, no provider. This is not a quote.");
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
      ? "Quotes unavailable until the Jupiter and RPC connection is configured."
      : "The quote was not requested. " + call.reason);
    return;
  }
  setStatus("Requesting a quote.");
  try {
    var response = await fetch(call.url, {
      method: call.method,
      credentials: call.credentials,
      headers: call.headers,
    });
    if (response.status === 503 || response.status === 502) {
      setStatus("The quote service is not ready. No numbers were returned.");
      return;
    }
    var body = await response.json();
    var view = response.ok ? quoteView(body) : emptyQuote();
    paint(view);
    setStatus(view.quoted
      ? "Quote received. It is not a transaction and it was not signed."
      : "The quote was rejected. No numbers are shown.");
  } catch (error) {
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
    clearQuote();
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
      clearQuote();
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
    clearQuote();
  });
});

if (fixture() && quoteButton) {
  quoteButton.disabled = true;
  quoteButton.textContent = "Quotes unavailable until the Jupiter and RPC connection is configured.";
  setStatus("Preview fixture, no provider. This is not a quote.");
} else if (quoteButton) {
  if (!tradingReady(window.VALHALLA_SITE || {})) {
    quoteButton.disabled = true;
    quoteButton.textContent = "Quotes unavailable until the Jupiter and RPC connection is configured.";
    setStatus("Preview release. Quotes unavailable until the Jupiter and RPC connection is configured.");
  }
}

paint(emptyQuote());
renderWatch();
refreshWallets();
