const { measureProof } = require('../website/scripts/proof-core.cjs');

const TTL_MS = 5 * 60 * 1000;
let cached = null;

module.exports = async function handler(req, res) {
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    cached = { at: now, body: await measureProof(fetch, process.env, new Date()) };
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=300');
  res.end(JSON.stringify(cached.body));
};
