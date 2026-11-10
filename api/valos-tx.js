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
  if (body.signature && !body.signedTransaction) {
    const report = await swap.transactionStatus(process.env, fetch, body.signature);
    if (!report.ok) return send(res, report.status, { error: report.error });
    return send(res, 200, report);
  }
  const sent = await swap.sendSigned(process.env, fetch, body.signedTransaction);
  if (!sent.ok) return send(res, sent.status, { error: sent.error });
  const report = await swap.transactionStatus(process.env, fetch, sent.signature);
  return send(res, 200, {
    signature: sent.signature,
    confirmation: report.ok ? report.confirmation : 'not-reported',
    err: report.ok ? report.err : null
  });
};
