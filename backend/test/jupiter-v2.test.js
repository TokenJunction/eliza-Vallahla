import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../valhallaMasterEngineV35.js";
import { jupiterBuildUrl, parseBuild, rpcStatusRequest } from "../jupiter-v2.js";

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

function buildBody(extra = {}) {
  return {
    inputMint,
    outputMint,
    inAmount: "1000",
    outAmount: "900",
    otherAmountThreshold: "890",
    slippageBps: 50,
    priceImpactPct: "0.001",
    routePlan: [],
    swapInstruction: instruction(),
    setupInstructions: [],
    cleanupInstruction: null,
    addressesByLookupTableAddress: { [inputMint]: [outputMint] },
    blockhashWithMetadata: { blockhash: Array.from({ length: 32 }, () => 1), lastValidBlockHeight: 10 },
    transactionVersion: 0,
    ...extra,
  };
}

test("the build url is only the official v2 path", () => {
  const planned = jupiterBuildUrl({ inputMint, outputMint, amount: "1000", taker, slippageBps: "50" });
  const url = new URL(planned.href);
  assert.equal(planned.ok, true);
  assert.equal(url.host, "api.jup.ag");
  assert.equal(url.pathname, "/swap/v2/build");
  assert.equal(url.searchParams.get("taker"), taker);
  assert.equal(planned.signed, false);
  assert.equal(jupiterBuildUrl({ inputMint, outputMint, amount: "1000", taker, host: "quote-api.jup.ag" }).reason, "host");
  assert.equal(jupiterBuildUrl({ inputMint, outputMint, amount: "1000", taker, url: "https://evil.example/swap/v6/quote" }).reason, "host");
  assert.equal(rpcStatusRequest("").configured, false);
  assert.equal(rpcStatusRequest("https://api.jup.ag").reason, "host");
  assert.equal(rpcStatusRequest("https://rpc.example/sendTransaction").reason, "path");
  assert.equal(rpcStatusRequest("https://rpc.example").method, "getHealth");
  assert.equal(rpcStatusRequest("https://rpc.example").sendTransaction, false);
});

test("a v2 build body is prepared unsigned and a bad lookup table is rejected", () => {
  const prepared = parseBuild(buildBody({ secret: "do-not-keep", execute: true }));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.executed, false);
  assert.equal(prepared.signed, false);
  assert.equal(prepared.signature, null);
  assert.equal(prepared.tx, null);
  assert.equal(Object.hasOwn(prepared, "secret"), false);
  assert.equal(Object.hasOwn(prepared, "execute"), false);
  assert.equal(prepared.addressesByLookupTableAddress[inputMint][0], outputMint);
  assert.equal(prepared.blockhashWithMetadata.lastValidBlockHeight, 10);
  const bad = parseBuild(buildBody({
    addressesByLookupTableAddress: { "not-a-key": [outputMint] },
  }));
  assert.equal(bad.reason, "alt");
  assert.equal(bad.signed, false);
});

test("the quote route calls v2 build and does not sign", async () => {
  const calls = [];
  const app = createServer({
    env: {
      SESSION_SECRET: "test-secret",
      CUSTOMER_ADMIN_EMAIL: "root@customer.test",
      JUPITER_API_KEY: "jupiter-test-key",
      SOLANA_RPC_URL: "https://rpc.example",
    },
    resolveImpl: async () => ["203.0.113.10"],
    fetchImpl: async (href, options) => {
      calls.push({ href, options });
      if (String(href).includes("api.jup.ag")) return { ok: true, json: async () => buildBody() };
      const body = JSON.parse(options.body);
      assert.equal(body.method, "getHealth");
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "ok" }) };
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const boot = await fetch(base + "/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@customer.test", code: app.state.bootstrapCode, deviceId: "d1" }),
    });
    const token = (await boot.json()).token;
    const denied = await fetch(base + "/api/jupiter/quote");
    assert.equal(denied.status, 401);
    const quote = await fetch(base + `/api/jupiter/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=1000&taker=${taker}&host=quote-api.jup.ag`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(quote.status, 400);
    assert.equal(calls.length, 0);
    const ok = await fetch(base + `/api/jupiter/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=1000&taker=${taker}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.executed, false);
    assert.equal(body.signed, false);
    assert.equal(body.signature, null);
    assert.equal(new URL(calls[0].href).pathname, "/swap/v2/build");
    assert.equal(calls[0].options.headers["x-api-key"], "jupiter-test-key");
    assert.equal(JSON.stringify(body).includes("jupiter-test-key"), false);
    const paper = await fetch(base + "/api/jupiter/paper", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ execute: true, quote: body }),
    });
    assert.equal(paper.status, 403);
    assert.equal((await paper.json()).signature, null);
    const rpc = await fetch(base + "/api/solana/rpc-status", { headers: { authorization: `Bearer ${token}` } });
    const health = await rpc.json();
    assert.equal(health.method, "getHealth");
    assert.equal(health.sendTransaction, false);
    assert.equal(calls[1].options.body.includes("sendTransaction"), false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
