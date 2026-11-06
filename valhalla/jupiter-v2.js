// Jupiter Swap API v2 build. Host and path are fixed.
// This prepares an unsigned quote. It does not sign, send, or call /execute.
// Address-lookup assembly stays with the Forge helper until that handoff arrives.

export const JUPITER_HOST = "api.jup.ag";
export const JUPITER_PATH = "/swap/v2/build";
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function jupiterBuildUrl(query) {
  const input = query || {};
  if (input.url || input.host || input.base || input.path) return { ok: false, reason: "host" };
  if (!PUBKEY.test(String(input.inputMint || "")) || !PUBKEY.test(String(input.outputMint || ""))) {
    return { ok: false, reason: "mint" };
  }
  if (!PUBKEY.test(String(input.taker || ""))) return { ok: false, reason: "taker" };
  if (!/^[1-9]\d{0,17}$/.test(String(input.amount || ""))) return { ok: false, reason: "amount" };
  const url = new URL(`https://${JUPITER_HOST}${JUPITER_PATH}`);
  if (url.host !== JUPITER_HOST || url.pathname !== JUPITER_PATH) return { ok: false, reason: "host" };
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", String(input.amount));
  url.searchParams.set("taker", input.taker);
  if (input.slippageBps != null && input.slippageBps !== "") {
    const slippage = Number(input.slippageBps);
    if (!Number.isInteger(slippage) || slippage < 0 || slippage > 10000) return { ok: false, reason: "slippage" };
    url.searchParams.set("slippageBps", String(slippage));
  }
  return { ok: true, href: url.href, host: url.host, path: url.pathname, executed: false, signed: false };
}

function instructionOk(value) {
  if (!value || typeof value !== "object") return false;
  if (!PUBKEY.test(String(value.programId || ""))) return false;
  if (typeof value.data !== "string" || !value.data) return false;
  if (!Array.isArray(value.accounts)) return false;
  return value.accounts.every((account) => account
    && PUBKEY.test(String(account.pubkey || ""))
    && typeof account.isWritable === "boolean"
    && typeof account.isSigner === "boolean");
}

export function parseBuild(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "body", executed: false, signed: false };
  if (!PUBKEY.test(String(body.inputMint || "")) || !PUBKEY.test(String(body.outputMint || ""))) {
    return { ok: false, reason: "mint", executed: false, signed: false };
  }
  if (!/^\d+$/.test(String(body.inAmount || "")) || !/^\d+$/.test(String(body.outAmount || ""))) {
    return { ok: false, reason: "amount", executed: false, signed: false };
  }
  if (!instructionOk(body.swapInstruction)) return { ok: false, reason: "swap-instruction", executed: false, signed: false };
  const tables = body.addressesByLookupTableAddress;
  if (tables != null) {
    if (typeof tables !== "object" || Array.isArray(tables)) return { ok: false, reason: "alt", executed: false, signed: false };
    for (const [table, keys] of Object.entries(tables)) {
      if (!PUBKEY.test(table) || !Array.isArray(keys) || keys.some((key) => !PUBKEY.test(String(key)))) {
        return { ok: false, reason: "alt", executed: false, signed: false };
      }
    }
  }
  const meta = body.blockhashWithMetadata;
  if (meta != null) {
    const bytes = meta.blockhash;
    const height = meta.lastValidBlockHeight;
    if (!Array.isArray(bytes) || bytes.length !== 32 || bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      return { ok: false, reason: "blockhash", executed: false, signed: false };
    }
    if (!Number.isInteger(height) || height < 0) return { ok: false, reason: "blockhash", executed: false, signed: false };
  }
  return {
    ok: true,
    mode: "prepare",
    executed: false,
    signed: false,
    signature: null,
    tx: null,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    inAmount: String(body.inAmount),
    outAmount: String(body.outAmount),
    otherAmountThreshold: body.otherAmountThreshold == null ? null : String(body.otherAmountThreshold),
    slippageBps: body.slippageBps ?? null,
    priceImpactPct: body.priceImpactPct == null ? null : String(body.priceImpactPct),
    routePlan: Array.isArray(body.routePlan) ? body.routePlan : [],
    swapInstruction: body.swapInstruction,
    setupInstructions: Array.isArray(body.setupInstructions) ? body.setupInstructions : [],
    cleanupInstruction: body.cleanupInstruction || null,
    addressesByLookupTableAddress: tables || {},
    blockhashWithMetadata: meta || null,
    transactionVersion: body.transactionVersion ?? null,
  };
}

export function rpcStatusRequest(raw) {
  if (!raw) return { ok: false, configured: false, reason: "unconfigured", method: null };
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, configured: false, reason: "url", method: null };
  }
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, configured: true, reason: "url", method: null };
  if (url.host === JUPITER_HOST || url.host === "quote-api.jup.ag") return { ok: false, configured: true, reason: "host", method: null };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, configured: true, reason: "path", method: null };
  return {
    ok: true,
    configured: true,
    href: url.origin,
    host: url.host,
    method: "getHealth",
    sendTransaction: false,
  };
}
