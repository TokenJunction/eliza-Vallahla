const { entranceConfig } = require('../website/scripts/entrance-config.cjs');

module.exports = function handler(req, res) {
  res.statusCode = req.method === 'GET' || req.method === 'HEAD' ? 200 : 405;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }
  res.end(JSON.stringify(entranceConfig(process.env)));
};
