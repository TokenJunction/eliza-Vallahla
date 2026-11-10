const { handlePush } = require('../website/scripts/admin-core.cjs');
const { readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const raw = await readRawBody(req);
  const result = await handlePush({
    method: req.method,
    headers: req.headers || {},
    body: raw
  }, process.env, fetch, Date.now());
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
