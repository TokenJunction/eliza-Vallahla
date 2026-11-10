const { handleWebhook } = require('../website/scripts/stripe-core.cjs');

function readStripeBody(req) {
  if (!req || req.body == null) {
    if (!req || typeof req.on !== 'function') return Promise.resolve('');
  } else if (typeof req.body === 'string') {
    return Promise.resolve(req.body);
  } else if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body.toString('utf8'));
  } else {
    return Promise.resolve(null);
  }
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const raw = await readStripeBody(req);
  const result = raw == null
    ? { status: 400, body: { error: 'Invalid payload.' } }
    : await handleWebhook({
      method: req.method,
      headers: req.headers || {},
      body: raw
    }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
