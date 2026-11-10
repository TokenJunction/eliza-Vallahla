const { handlePush } = require('../website/scripts/push-core.cjs');
const { readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const raw = req.method === 'GET' ? '' : await readRawBody(req);
  const result = await handlePush({ method: req.method, headers: req.headers || {}, body: raw }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  const encoded = JSON.stringify(result.body);
  if (process.env.VAPID_PRIVATE_KEY && encoded.includes(process.env.VAPID_PRIVATE_KEY)) {
    res.statusCode = 500;
    res.end('{"error":"Push not configured"}');
    return;
  }
  res.end(encoded);
};
