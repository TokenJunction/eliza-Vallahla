import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jupiterBuildUrl, parseBuild } from "./jupiter-v2.js";
import { encodeBase58, readVersionedTransaction, reviewTransaction, signatureLink } from "./tx.js";
import { baseUnits, emptyQuote, quoteRequest, quoteView, signPlan, submitRequest, tradingReady } from "./trading.js";

const inputMint = "So11111111111111111111111111111111111111112";
const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const taker = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";

function instruction() {
  return {
    programId: inputMint,
    accounts: [{ pubkey: taker, isWritable: true, isSigner: true }],
    data: "aGVsbG8=",
  };
}

function craft(feePayer, signature) {
  const bytes = [1];
  const sig = signature || new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) bytes.push(sig[i] || 0);
  bytes.push(0x80, 1, 0, 0, 1);
  for (let i = 0; i < 32; i += 1) bytes.push(feePayer[i]);
  for (let i = 0; i < 32; i += 1) bytes.push(2);
  bytes.push(0, 0);
  return Uint8Array.from(bytes);
}

test("the quote stays on the inspected v2 build and does not run while trading is off", () => {
  const planned = jupiterBuildUrl({ inputMint, outputMint, amount: "1000", taker, slippageBps: 50 });
  assert.equal(new URL(planned.href).host, "api.jup.ag");
  assert.equal(new URL(planned.href).pathname, "/swap/v2/build");
  assert.equal(tradingReady({ TRADING_ENABLED: false, AGENT_API_URL: "https://api.example" }), false);
  const blocked = quoteRequest({ TRADING_ENABLED: false, AGENT_API_URL: "https://api.example" }, "token", {
    inputMint, outputMint, amount: "1000", taker,
  });
  assert.equal(blocked.reason, "disabled");
  assert.equal(quoteRequest({ TRADING_ENABLED: true, AGENT_API_URL: "https://evil.example" }, "token", {
    inputMint, outputMint, amount: "1000", taker,
  }).reason, "unconfigured");
  const call = quoteRequest({ TRADING_ENABLED: true, AGENT_API_URL: "https://eliza-valhalla.onrender.com" }, "token", {
    inputMint, outputMint, amount: "1000", taker, slippageBps: 50,
  });
  const url = new URL(call.url);
  assert.equal(url.origin, "https://eliza-valhalla.onrender.com");
  assert.equal(url.pathname, "/api/jupiter/quote");
  assert.equal(url.searchParams.get("taker"), taker);
  assert.equal(call.method, "GET");
  assert.equal(call.credentials, "omit");
});

test("an empty quote has no numbers and a bad build is not shown", () => {
  assert.equal(emptyQuote().outAmount, "");
  assert.equal(quoteView(null).quoted, false);
  const view = quoteView({
    inputMint, outputMint, inAmount: "1000", outAmount: "900", slippageBps: 50,
    priceImpactPct: "0.01",
    routePlan: [{ swapInfo: { label: "Whirlpool" } }],
    swapInstruction: instruction(),
  });
  assert.equal(view.outAmount, "900");
  assert.equal(view.note, "Whirlpool");
  assert.equal(parseBuild({ tx: "deadbeef" }).ok, false);
});

test("base units stay integers and the fee payer must be the connected wallet", () => {
  assert.equal(baseUnits("1.5", 9).amount, "1500000000");
  assert.equal(baseUnits("0", 9).ok, false);
  const feePayer = new Uint8Array(32).fill(7);
  const takerKey = encodeBase58(feePayer);
  const unsigned = craft(feePayer);
  const review = reviewTransaction(unsigned, takerKey);
  assert.equal(review.ok, true);
  assert.equal(review.signerCount, 1);
  assert.equal(review.signed, false);
  assert.equal(signPlan(unsigned, takerKey).action, "signTransaction");
  assert.equal(reviewTransaction(unsigned, encodeBase58(new Uint8Array(32).fill(9))).reason, "fee-payer");
  const signed = craft(feePayer, new Uint8Array(64).fill(4));
  assert.equal(signatureLink(signed).startsWith("https://solscan.io/tx/"), true);
  assert.equal(signatureLink(unsigned), null);
  assert.equal(readVersionedTransaction(craft(feePayer)).signerCount, 1);
  assert.equal(submitRequest().sent, false);
});

test("the desk names the Jupiter Terminal and does not sign and send", () => {
  const html = readFileSync("os/index.html", "utf8");
  const terminal = readFileSync("valhalla/terminal.js", "utf8");
  assert.equal(html.includes("Jupiter Terminal"), true);
  assert.equal(html.includes("PAPER-FIRST"), false);
  assert.equal(html.includes("Powered by Jupiter"), true);
  assert.equal(terminal.includes("signAndSendTransaction"), false);
  assert.equal(terminal.includes("window.solana"), false);
});
