'use strict';

function entranceConfig(env) {
  const key = String(env && env.CLERK_PUBLISHABLE_KEY || '');
  if (key.startsWith('pk_live_')) return { clerk: 'production', publishableKey: key };
  return { clerk: 'not-configured', publishableKey: '' };
}

module.exports = { entranceConfig };
