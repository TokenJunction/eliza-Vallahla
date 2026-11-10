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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  const status = swap.publicStatus(process.env);
  return send(res, 200, status);
};
