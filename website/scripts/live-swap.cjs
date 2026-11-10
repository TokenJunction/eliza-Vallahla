const crypto = require('node:crypto');
'use strict';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUBLISHED = {
  SOL: SOL_MINT,
  USDC: USDC_MINT
};

function publicStatus(env) {
  const source = env || {};
  const publishable = String(source.CLERK_PUBLISHABLE_KEY || '');
  const secret = String(source.CLERK_SECRET_KEY || '');
  const rpc = Boolean(source.HELIUS_API_KEY || source.SOLANA_RPC_URL);
  const production = publishable.startsWith('pk_live_') && secret.startsWith('sk_live_');
  const developmentOnly = publishable.startsWith('pk_test_') || secret.startsWith('sk_test_');
  const feeAccount = String(source.JUPITER_FEE_ACCOUNT || '');
  const feeBps = String(source.JUPITER_PLATFORM_FEE_BPS || '');
  return {
    clerk: production ? 'production' : (developmentOnly ? 'development-only' : 'missing'),
    clerkPublishableKey: production ? publishable : '',
    rpc: rpc ? 'configured' : 'not-connected',
    platformFee: feeAccount && feeBps ? 'configured' : 'none',
    liveTrading: production && rpc
  };
}

function rpcUrl(env) {
  if (env && env.SOLANA_RPC_URL) return String(env.SOLANA_RPC_URL);
  if (env && env.HELIUS_API_KEY) return 'https://mainnet.helius-rpc.com/?api-key=' + env.HELIUS_API_KEY;
  return '';
}

function readJson(response) {
  if (!response || typeof response.json !== 'function') return Promise.resolve(null);
  return response.json();
}

function sessionIdFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return '';
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return typeof json.sid === 'string' && /^[A-Za-z0-9_]+$/.test(json.sid) ? json.sid : '';
  } catch (error) {
    return '';
  }
}

async function requireSession(env, fetchImpl, token) {
  const status = publicStatus(env);
  if (status.clerk === 'development-only') {
    return { ok: false, status: 503, error: 'Production sign-in is not configured. Development keys are not treated as production.' };
  }
  if (status.clerk !== 'production') {
    return { ok: false, status: 503, error: 'Production sign-in is not configured.' };
  }
  const sessionId = sessionIdFromToken(token);
  if (!sessionId) return { ok: false, status: 401, error: 'Sign-in required.' };
  const response = await fetchImpl('https://api.clerk.com/v1/sessions/' + encodeURIComponent(sessionId) + '/verify', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.CLERK_SECRET_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ token: token })
  });
  if (!response || !response.ok) return { ok: false, status: 401, error: 'Sign-in required.' };
  return { ok: true, sessionId: sessionId };
}

function resolveMint(value) {
  const text = String(value || '').trim();
  if (/^volos$/i.test(text) || text === '$VALOS' || text === '$VOLOS') return { unpublished: true };
  if (PUBLISHED[text.toUpperCase()]) return { mint: PUBLISHED[text.toUpperCase()] };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return { mint: text };
  return { error: 'That token is not available from this desk.' };
}

async function quoteSwap(env, fetchImpl, input) {
  const inputMint = resolveMint(input && input.inputMint);
  const outputMint = resolveMint(input && input.outputMint);
  if (inputMint.unpublished || outputMint.unpublished) {
    return { ok: false, status: 409, error: 'Official contract not published. Swap for that token is disabled.' };
  }
  if (!inputMint.mint || !outputMint.mint) {
    return { ok: false, status: 400, error: inputMint.error || outputMint.error };
  }
  const amount = Number(input && input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, status: 400, error: 'Amount is not valid.' };
  const slippageBps = Number(input && input.slippageBps);
  const slippage = Number.isFinite(slippageBps) && slippageBps >= 1 && slippageBps <= 500 ? slippageBps : 25;
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint.mint);
  url.searchParams.set('outputMint', outputMint.mint);
  url.searchParams.set('amount', String(Math.round(amount)));
  url.searchParams.set('slippageBps', String(slippage));
  const status = publicStatus(env);
  if (status.platformFee === 'configured') url.searchParams.set('platformFeeBps', String(env.JUPITER_PLATFORM_FEE_BPS));
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET' });
  } catch (error) {
    return { ok: false, status: 502, error: 'Jupiter quote is not connected.' };
  }
  if (!response || !response.ok) return { ok: false, status: 502, error: 'Jupiter quote is not connected.' };
  const body = await readJson(response);
  if (!body || !body.outAmount) return { ok: false, status: 502, error: 'Jupiter quote is not connected.' };
  return { ok: true, quote: body, platformFee: status.platformFee, slippageBps: slippage };
}

async function buildSwap(env, fetchImpl, quoteResponse, userPublicKey) {
  if (!quoteResponse || !quoteResponse.outAmount) return { ok: false, status: 400, error: 'A Jupiter quote is required before a swap.' };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(userPublicKey || ''))) {
    return { ok: false, status: 400, error: 'Connect a wallet before asking it to sign.' };
  }
  const payload = {
    quoteResponse: quoteResponse,
    userPublicKey: userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true
  };
  if (publicStatus(env).platformFee === 'configured') payload.feeAccount = env.JUPITER_FEE_ACCOUNT;
  let response;
  try {
    response = await fetchImpl('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return { ok: false, status: 502, error: 'Jupiter swap build is not connected.' };
  }
  if (!response || !response.ok) return { ok: false, status: 502, error: 'Jupiter swap build is not connected.' };
  const body = await readJson(response);
  if (!body || !body.swapTransaction) return { ok: false, status: 502, error: 'Jupiter did not return an unsigned transaction.' };
  return { ok: true, swapTransaction: body.swapTransaction, platformFee: publicStatus(env).platformFee };
}

function messageBytes(encoded) {
  let raw;
  try { raw = Buffer.from(String(encoded || ''), 'base64'); }
  catch (error) { return null; }
  if (!raw || raw.length < 66) return null;
  let length = 0;
  let size = 0;
  while (size < 3 && size < raw.length) {
    const elem = raw[size];
    length |= (elem & 0x7f) << (size * 7);
    size += 1;
    if ((elem & 0x80) === 0) break;
  }
  if (length < 1 || length > 8) return null;
  const start = size + length * 64;
  if (start >= raw.length) return null;
  return raw.subarray(start);
}

function bindPayload(sessionId, userPublicKey, digest, exp) {
  return [sessionId, userPublicKey, digest, String(exp)].join('|');
}

function bindTicket(env, sessionId, userPublicKey, unsignedTransaction) {
  const message = messageBytes(unsignedTransaction);
  if (!message || !env || !env.CLERK_SECRET_KEY) return null;
  const exp = Date.now() + 2 * 60 * 1000;
  const digest = crypto.createHash('sha256').update(message).digest('base64url');
  const mac = crypto.createHmac('sha256', env.CLERK_SECRET_KEY).update(bindPayload(sessionId, userPublicKey, digest, exp)).digest('base64url');
  return { exp: exp, mac: mac };
}

const sendHits = new Map();

function allowSend(sessionId, now) {
  const recent = (sendHits.get(sessionId) || []).filter(function (at) { return now - at < 60000; });
  if (recent.length >= 5) {
    sendHits.set(sessionId, recent);
    return false;
  }
  recent.push(now);
  sendHits.set(sessionId, recent);
  if (sendHits.size > 1000) sendHits.clear();
  return true;
}

async function sendBound(env, fetchImpl, sessionId, userPublicKey, signedTransaction, ticket, now) {
  const checkedAt = now || Date.now();
  if (!allowSend(sessionId, checkedAt)) return { ok: false, status: 429, error: 'Too many send attempts. Nothing was sent.' };
  if (!ticket || !ticket.mac || !ticket.exp) return { ok: false, status: 400, error: 'This send is not tied to a Jupiter build. Nothing was sent.' };
  if (Number(ticket.exp) < checkedAt) return { ok: false, status: 400, error: 'The Jupiter build expired. Nothing was sent.' };
  const message = messageBytes(signedTransaction);
  if (!message || !env || !env.CLERK_SECRET_KEY) return { ok: false, status: 400, error: 'The signed transaction could not be checked. Nothing was sent.' };
  const digest = crypto.createHash('sha256').update(message).digest('base64url');
  const expected = crypto.createHmac('sha256', env.CLERK_SECRET_KEY).update(bindPayload(sessionId, userPublicKey, digest, ticket.exp)).digest('base64url');
  const left = Buffer.from(expected);
  const right = Buffer.from(String(ticket.mac));
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, status: 403, error: 'The signed transaction does not match the Jupiter build. Nothing was sent.' };
  }
  return sendSigned(env, fetchImpl, signedTransaction);
}

async function sendSigned(env, fetchImpl, signedTransaction) {
  const url = rpcUrl(env);
  if (!url) return { ok: false, status: 503, error: 'RPC not connected. The signed transaction was not sent.' };
  if (!signedTransaction || String(signedTransaction).length < 32) {
    return { ok: false, status: 400, error: 'No signed transaction was provided. Nothing was sent.' };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [signedTransaction, { encoding: 'base64', skipPreflight: false, maxRetries: 2 }]
      })
    });
  } catch (error) {
    return { ok: false, status: 502, error: 'RPC not connected. The signed transaction was not sent.' };
  }
  const body = await readJson(response);
  if (!body || body.error || !body.result) return { ok: false, status: 502, error: 'The RPC did not accept the transaction.' };
  return { ok: true, signature: body.result };
}

async function transactionStatus(env, fetchImpl, signature) {
  const url = rpcUrl(env);
  if (!url) return { ok: false, status: 503, error: 'RPC not connected.' };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(String(signature || ''))) {
    return { ok: false, status: 400, error: 'No signature to check.' };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }]
      })
    });
  } catch (error) {
    return { ok: false, status: 502, error: 'RPC not connected.' };
  }
  const body = await readJson(response);
  const value = body && body.result && body.result.value && body.result.value[0];
  if (!value) return { ok: true, signature: signature, confirmation: 'not-reported', err: null };
  return {
    ok: true,
    signature: signature,
    confirmation: value.confirmationStatus || 'not-reported',
    err: value.err || null
  };
}

module.exports = {
  SOL_MINT: SOL_MINT,
  USDC_MINT: USDC_MINT,
  publicStatus: publicStatus,
  requireSession: requireSession,
  quoteSwap: quoteSwap,
  buildSwap: buildSwap,
  bindTicket: bindTicket,
  sendBound: sendBound,
  sendSigned: sendSigned,
  transactionStatus: transactionStatus
};
