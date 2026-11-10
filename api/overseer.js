const { handleOverseer } = require('../website/scripts/admin-core.cjs');

module.exports = async function handler(req, res) {
  const result = await handleOverseer({
    method: req.method,
    headers: req.headers || {}
  }, process.env, fetch, Date.now());
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
