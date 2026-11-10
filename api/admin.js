const { handleAdmin } = require('../website/scripts/admin-core.cjs');
const { readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const raw = req.method === 'GET' ? '' : await readRawBody(req);
  const result = await handleAdmin({
    method: req.method,
    headers: req.headers || {},
    body: raw,
    url: req.url || '/api/admin'
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (result.headers) {
    Object.keys(result.headers).forEach(function (name) { res.setHeader(name, result.headers[name]); });
  }
  if (result.raw) {
    res.setHeader('content-type', result.type || 'application/octet-stream');
    res.end(result.raw);
    return;
  }
  if (result.html) {
    res.setHeader('content-type', result.type || 'text/html; charset=utf-8');
    res.end(result.html);
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(result.body));
};
