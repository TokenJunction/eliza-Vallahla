const { notifyUsers } = require('../website/scripts/push-core.cjs');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!secret || header !== 'Bearer ' + secret) {
    res.statusCode = 401;
    res.end('{"error":"Not authorized."}');
    return;
  }
  let failed = true;
  let label = 'A health check failed.';
  try {
    const response = await fetch('https://valhalla-app.xyz/api/overseer-status');
    const body = response && response.ok ? await response.json() : null;
    if (body && body.label) label = body.label;
    failed = !body || !Array.isArray(body.checks) || !body.checks.length || body.checks.some(function (row) { return !row.ok; });
  } catch (error) {
    failed = true;
  }
  if (failed) {
    await notifyUsers(process.env, fetch, { title: 'Health check failed', body: label });
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
};
