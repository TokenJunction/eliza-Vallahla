const { handleProof } = require('../website/scripts/proof-core.cjs');

module.exports = async function handler(req, res) {
  const result = await handleProof({
    method: req && req.method,
    headers: (req && req.headers) || {},
    url: (req && req.url) || ''
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', result.cache || 'no-store');
  res.end(JSON.stringify(result.body));
};
