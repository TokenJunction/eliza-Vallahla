import { VersionedTransaction } from '@solana/web3.js';

const gate = document.getElementById('gate-status');
const feeLine = document.getElementById('fee-line');
const routeLine = document.getElementById('route-line');
const receive = document.getElementById('receive-amount');
const walletLine = document.getElementById('wallet-line');
const plugins = document.getElementById('plugins');
const signIn = document.getElementById('sign-in');
const connect = document.getElementById('connect-wallet');
const quoteButton = document.getElementById('quote');
const swapButton = document.getElementById('swap');
const form = document.getElementById('swap-form');
let config = { clerk: 'missing', liveTrading: false, platformFee: 'none', rpc: 'not-connected' };
let clerkClient = null;
let signedIn = false;
let sessionToken = '';
let walletAddress = '';
let latestQuote = null;

function last4(value) {
  const text = String(value || '');
  return text.length < 4 ? '…' : '…' + text.slice(-4);
}

function paint() {
  connect.disabled = !signedIn;
  quoteButton.disabled = !signedIn || !walletAddress;
  swapButton.disabled = !signedIn || !walletAddress || !latestQuote;
  feeLine.textContent = config.platformFee === 'configured'
    ? 'A platform fee is configured on the server.'
    : 'No platform fee is configured.';
  plugins.innerHTML = [
    'Clerk: ' + config.clerk,
    'Jupiter: checked when a quote is requested',
    'RPC: ' + config.rpc
  ].map(function (line) { return '<li>' + line + '</li>'; }).join('');
}

async function loadConfig() {
  const response = await fetch('/api/valos-config', { cache: 'no-store' });
  config = await response.json();
  if (config.clerk === 'production' && config.clerkPublishableKey) {
    gate.textContent = 'Production sign-in is configured. Sign in, then connect your own wallet.';
    signIn.disabled = false;
  } else if (config.clerk === 'development-only') {
    gate.textContent = 'Production sign-in is not configured. Development keys are not treated as production.';
    signIn.disabled = true;
  } else {
    gate.textContent = 'Production sign-in is not configured. Swap stays unavailable.';
    signIn.disabled = true;
  }
  if (!config.liveTrading) routeLine.textContent = 'Live execution is not connected. A quote still requires production sign-in.';
  paint();
}

async function bearer() {
  if (clerkClient && clerkClient.session && typeof clerkClient.session.getToken === 'function') {
    sessionToken = await clerkClient.session.getToken() || '';
    signedIn = Boolean(sessionToken);
  }
  return { 'content-type': 'application/json', authorization: 'Bearer ' + sessionToken };
}

function rememberSession(session) {
  signedIn = Boolean(session);
  sessionToken = '';
  if (!session) {
    gate.textContent = 'Sign in to continue. A wallet connection does not sign you in.';
    latestQuote = null;
    paint();
    return;
  }
  gate.textContent = 'Signed in. Connect your own wallet. This does not spend the owner wallet.';
  paint();
}

async function startClerk() {
  if (config.clerk !== 'production' || !config.clerkPublishableKey) return;
  if (!clerkClient) {
    await new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.dataset.clerkPublishableKey = config.clerkPublishableKey;
      script.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Clerk did not load.')); };
      document.head.appendChild(script);
    });
    const ClerkClass = window.Clerk;
    clerkClient = typeof ClerkClass === 'function' ? new ClerkClass(config.clerkPublishableKey) : ClerkClass;
    await clerkClient.load();
    if (typeof clerkClient.addListener === 'function') {
      clerkClient.addListener(function (emission) {
        rememberSession((emission && emission.session) || clerkClient.session);
      });
    }
  }
  rememberSession(clerkClient.session);
  if (!clerkClient.session && typeof clerkClient.openSignIn === 'function') clerkClient.openSignIn();
}

async function connectWallet() {
  const provider = window.solflare || window.solana;
  if (!provider || typeof provider.connect !== 'function') {
    walletLine.textContent = 'No Solana wallet was detected. Nothing was signed.';
    return;
  }
  const result = await provider.connect();
  const address = String((result && (result.publicKey || result)) || provider.publicKey || '');
  walletAddress = address;
  walletLine.textContent = address
    ? 'Wallet connected ' + last4(address) + '. No signature was requested.'
    : 'The wallet did not return an address.';
  paint();
}

async function requestQuote() {
  latestQuote = null;
  receive.textContent = 'Quote not loaded';
  const pay = document.getElementById('pay-token').value;
  const out = document.getElementById('receive-token').value;
  if (pay === 'VOLOS' || out === 'VOLOS') {
    routeLine.textContent = 'Official contract not published. Swap for that token is disabled.';
    paint();
    return;
  }
  const whole = Number(document.getElementById('pay-amount').value);
  const decimals = pay === 'USDC' ? 6 : 9;
  const amount = Math.round(whole * (10 ** decimals));
  const slippageBps = Math.round(Number(document.getElementById('slippage').value) * 100);
  const response = await fetch('/api/valos-quote', {
    method: 'POST',
    headers: await bearer(),
    body: JSON.stringify({ inputMint: pay, outputMint: out, amount: amount, slippageBps: slippageBps })
  });
  const body = await response.json();
  if (!response.ok) {
    routeLine.textContent = body.error || 'Jupiter quote is not connected.';
    paint();
    return;
  }
  latestQuote = body.quote;
  const outDecimals = out === 'USDC' ? 6 : 9;
  receive.textContent = (Number(body.quote.outAmount) / (10 ** outDecimals)).toString();
  routeLine.textContent = 'Jupiter route loaded. Slippage ' + (body.slippageBps / 100) + '%. Nothing has been sent.';
  paint();
}

async function confirmSwap(event) {
  event.preventDefault();
  if (!latestQuote || !walletAddress) return;
  const provider = window.solflare || window.solana;
  const built = await fetch('/api/valos-swap', {
    method: 'POST',
    headers: await bearer(),
    body: JSON.stringify({ quoteResponse: latestQuote, userPublicKey: walletAddress })
  });
  const swapBody = await built.json();
  if (!built.ok) {
    document.getElementById('tx-status').textContent = swapBody.error || 'Jupiter swap build is not connected.';
    return;
  }
  const bytes = Uint8Array.from(atob(swapBody.swapTransaction), function (char) { return char.charCodeAt(0); });
  const transaction = VersionedTransaction.deserialize(bytes);
  let signed;
  try {
    signed = await provider.signTransaction(transaction);
  } catch (error) {
    document.getElementById('tx-status').textContent = 'The wallet did not sign. Nothing was sent.';
    return;
  }
  const raw = btoa(String.fromCharCode.apply(null, signed.serialize()));
  const sent = await fetch('/api/valos-send', {
    method: 'POST',
    headers: await bearer(),
    body: JSON.stringify({ signedTransaction: raw })
  });
  const sentBody = await sent.json();
  if (!sent.ok) {
    document.getElementById('tx-status').textContent = sentBody.error || 'RPC not connected.';
    return;
  }
  document.getElementById('tx-signature').textContent = sentBody.signature;
  const report = await fetch('/api/valos-tx', {
    method: 'POST',
    headers: await bearer(),
    body: JSON.stringify({ signature: sentBody.signature })
  });
  const reportBody = await report.json();
  document.getElementById('tx-status').textContent = report.ok
    ? (reportBody.confirmation || 'not-reported')
    : (reportBody.error || 'Not reported.');
}

function clearQuote() {
  latestQuote = null;
  receive.textContent = 'Quote not loaded';
  routeLine.textContent = 'Route not loaded. Get a new quote before swapping.';
  paint();
}
['pay-token', 'receive-token', 'pay-amount', 'slippage'].forEach(function (id) {
  const field = document.getElementById(id);
  field.addEventListener('input', clearQuote);
  field.addEventListener('change', clearQuote);
});
document.getElementById('prepare').addEventListener('click', function () {
  routeLine.textContent = 'Ticket prepared. Confirm in your wallet to sign. This did not send a transaction.';
});
signIn.addEventListener('click', function () { startClerk().catch(function (error) { gate.textContent = error.message; }); });
connect.addEventListener('click', function () { connectWallet().catch(function () { walletLine.textContent = 'Wallet connection was not completed.'; }); });
quoteButton.addEventListener('click', function () { requestQuote().catch(function () { routeLine.textContent = 'Jupiter quote is not connected.'; }); });
form.addEventListener('submit', function (event) { confirmSwap(event).catch(function () { document.getElementById('tx-status').textContent = 'Swap was not sent.'; }); });
loadConfig().catch(function () {
  gate.textContent = 'Production sign-in is not configured. Swap stays unavailable.';
  signIn.disabled = true;
  connect.disabled = true;
  quoteButton.disabled = true;
  swapButton.disabled = true;
});
