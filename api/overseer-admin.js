const { handleOwnerAction } = require('../website/scripts/push-core.cjs');
const { readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const result = await handleOwnerAction({
    method: req.method,
    headers: req.headers || {},
    body: await readRawBody(req)
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
