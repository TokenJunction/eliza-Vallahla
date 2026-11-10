const swap = require('../website/scripts/live-swap.cjs');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (error) { resolve({}); }
    });
  });
}

function token(req) {
  return String(req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/i, '');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
  const session = await swap.requireSession(process.env, fetch, token(req));
  if (!session.ok) return send(res, session.status, { error: session.error });
  const body = await readBody(req);
  const built = await swap.buildSwap(process.env, fetch, body.quoteResponse, body.userPublicKey);
  if (!built.ok) return send(res, built.status, { error: built.error });
  const bind = swap.bindTicket(process.env, session.sessionId, body.userPublicKey, built.swapTransaction);
  if (!bind) return send(res, 503, { error: 'The Jupiter build could not be bound to this sign-in. Nothing was sent.' });
  return send(res, 200, { swapTransaction: built.swapTransaction, platformFee: built.platformFee, bind: bind });
};
