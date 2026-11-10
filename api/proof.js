const { measureProof } = require('../website/scripts/proof-core.cjs');

const TTL_MS = 5 * 60 * 1000;
let cached = null;
let inflight = null;

module.exports = async function handler(req, res) {
  if (!req || req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    if (!inflight) {
      inflight = measureProof(fetch, process.env, new Date()).then(function (body) {
        cached = { at: Date.now(), body: body };
        return body;
      }).finally(function () {
        inflight = null;
      });
    }
    try {
      await inflight;
    } catch (error) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ error: 'Proof not checked.' }));
      return;
    }
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=300');
  res.end(JSON.stringify(cached && cached.body));
};
