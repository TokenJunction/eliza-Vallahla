'use strict';

const DOMAIN = 'valhallaos.us.auth0.com';

function entranceConfig(env) {
  const source = env || {};
  const domain = String(source.AUTH0_DOMAIN || '').trim();
  const clientId = String(source.AUTH0_CLIENT_ID || '').trim();
  const privy = String(source.PRIVY_APP_ID || '').trim();
  const closed = { auth0: 'not-configured', domain: '', clientId: '', privyAppId: '', wallet: 'not-configured' };
  if (domain !== DOMAIN) return closed;
  if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) return closed;
  if (/secret|sk_|pk_test|pk_live/i.test(clientId)) return closed;
  const config = {
    auth0: 'configured',
    domain: DOMAIN,
    clientId: clientId,
    privyAppId: '',
    wallet: 'not-configured'
  };
  if (/^[A-Za-z0-9_-]{8,80}$/.test(privy) && !/secret|sk_|pk_/i.test(privy)) {
    config.privyAppId = privy;
    config.wallet = 'external';
  }
  return config;
}

module.exports = { entranceConfig, DOMAIN };
