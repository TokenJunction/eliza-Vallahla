const { handleCheckout } = require('../website/scripts/stripe-core.cjs');

module.exports = async function handler(req, res) {
  const result = await handleCheckout({
    method: req.method,
    headers: req.headers || {}
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
