const TARGETS = [
  { name: 'Apex', url: 'https://valhalla-app.xyz/' },
  { name: 'Desk', url: 'https://valhalla-app.xyz/os/' },
  { name: 'Coin', url: 'https://valos.live/' }
];

module.exports = async function handler(req, res) {
  const checks = await Promise.all(TARGETS.map(async function (target) {
    try {
      const response = await fetch(target.url, { method: 'GET' });
      return { name: target.name, ok: response.status >= 200 && response.status < 400 };
    } catch (error) {
      return { name: target.name, ok: false };
    }
  }));
  const ok = checks.every(function (row) { return row.ok; });
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({
    label: ok ? 'All checks passed.' : 'A health check failed.',
    checks: checks
  }));
};
