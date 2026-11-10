const { notifyUsers } = require('../website/scripts/push-core.cjs');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!secret || header !== 'Bearer ' + secret) {
    res.statusCode = 401;
    res.end('{"error":"Not authorized."}');
    return;
  }
  const response = await fetch('https://valhalla-app.xyz/api/overseer-status');
  const body = response && response.ok ? await response.json() : { label: 'A health check failed.', checks: [] };
  if (!body.checks || body.checks.some(function (row) { return !row.ok; }) || !response || !response.ok) {
    await notifyUsers(process.env, fetch, { title: 'Health check failed', body: body.label || 'A health check failed.' });
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
};
