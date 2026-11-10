const { handleMechas } = require('../website/scripts/mecha-core.cjs');
const { readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const raw = req.method === 'GET' ? '' : await readRawBody(req);
  const result = await handleMechas({ method: req.method, headers: req.headers || {}, body: raw }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
