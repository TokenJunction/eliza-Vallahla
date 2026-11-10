const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { entranceConfig } = require('./entrance-config.cjs');
const account = require('../account-level.js');
const auth = require('../auth0-gate.js');

const root = path.join(__dirname, '../..');
const CLIENT = 'XpMkSDCYyMCzphPwGfC1FyiE6OQaLNnk';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Auth0 is read from public env and Clerk keys are not a fallback', () => {
  assert.equal(entranceConfig({}).auth0, 'not-configured');
  assert.equal(entranceConfig({ CLERK_PUBLISHABLE_KEY: 'pk_test_example' }).auth0, 'not-configured');
  assert.equal(JSON.stringify(entranceConfig({ CLERK_PUBLISHABLE_KEY: 'pk_test_example' })).includes('pk_test_'), false);
  const config = entranceConfig({ AUTH0_DOMAIN: 'valhallaos.us.auth0.com', AUTH0_CLIENT_ID: CLIENT });
  assert.equal(config.auth0, 'configured');
  assert.equal(config.domain, 'valhallaos.us.auth0.com');
  assert.equal(config.clientId, CLIENT);
  assert.equal(config.wallet, 'not-configured');
  assert.equal(entranceConfig({ AUTH0_DOMAIN: 'evil.example', AUTH0_CLIENT_ID: CLIENT }).auth0, 'not-configured');
  assert.equal(entranceConfig({ AUTH0_DOMAIN: 'valhallaos.us.auth0.com', AUTH0_CLIENT_ID: 'client_secret_value' }).auth0, 'not-configured');
  const withWallet = entranceConfig({ AUTH0_DOMAIN: 'valhallaos.us.auth0.com', AUTH0_CLIENT_ID: CLIENT, PRIVY_APP_ID: 'privyappid' });
  assert.equal(withWallet.wallet, 'external');
  assert.equal(withWallet.privyAppId, 'privyappid');
});

test('the Auth0 redirect stays on the public callback URLs and out of localStorage', () => {
  const config = entranceConfig({ AUTH0_DOMAIN: 'valhallaos.us.auth0.com', AUTH0_CLIENT_ID: CLIENT });
  assert.deepEqual(auth.CALLBACKS, [
    'https://valhalla-app.xyz/',
    'https://www.valhalla-app.xyz/',
    'https://valhalla-app.xyz/app/',
    'https://www.valhalla-app.xyz/app/'
  ]);
  assert.equal(auth.redirectUri('https://www.valhalla-app.xyz/app/welcome'), 'https://www.valhalla-app.xyz/app/');
  assert.equal(auth.redirectUri('http://127.0.0.1:8765/'), '');
  assert.equal(auth.hasCallback('?code=abc&state=def'), true);
  assert.equal(auth.hasCallback('?error=access_denied'), false);
  const options = auth.clientOptions(config, 'https://valhalla-app.xyz/');
  assert.equal(options.domain, 'valhallaos.us.auth0.com');
  assert.equal(options.clientId, CLIENT);
  assert.equal(options.cacheLocation, 'memory');
  assert.equal(options.useRefreshTokens, false);
  assert.equal(options.authorizationParams.redirect_uri, 'https://valhalla-app.xyz/');
  assert.equal(auth.clientOptions(config, 'http://127.0.0.1:8765/'), null);
  const source = read('website/auth0-gate.js') + read('website/home.js') + read('website/os/session.js');
  assert.match(source, /cacheLocation: 'memory'/);
  assert.match(source, /loginWithRedirect/);
  assert.match(source, /handleRedirectCallback/);
  assert.doesNotMatch(source, /localStorage|client_secret|@clerk/);
  assert.equal(auth.logoutReturnTo, 'https://valhalla-app.xyz/');
});

test('missing plans stay FREE and named plans are read from Auth0 app metadata', () => {
  const unset = account.levelFromUser({ sub: 'auth0|person' });
  assert.equal(unset.level, 'FREE');
  assert.equal(unset.configured, false);
  assert.match(unset.note, /Plans are not configured/);
  assert.equal(account.levelFromUser({ publicMetadata: { plan: 'PRO' } }).configured, false);
  assert.equal(account.levelFromUser({ app_metadata: { plan: 'pro' } }).level, 'PRO');
  assert.equal(account.levelFromUser({ 'https://valhalla-app.xyz/app_metadata': { features: ['unlimited'] } }).level, 'UNLIMITED');
  assert.equal(account.toolAllowed('FREE', 'wallet'), true);
  assert.equal(account.toolAllowed('FREE', 'monitor'), false);
  assert.equal(account.toolAllowed('PRO', 'swap'), false);
});

test('public pages do not offer the paper desk, Clerk, or the repository', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') walk(full);
      }
      else if (entry.name.endsWith('.html') || entry.name.endsWith('.js')) files.push(full);
    }
  }
  walk(path.join(root, 'website'));
  const blob = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(blob, /github\.com\/TokenJunction|@clerk|clerk-sign-in|client_secret/);
  assert.doesNotMatch(blob, /Public desk|Preview the public paper desk|Explore the public ValhallaOS desk/);
  assert.match(read('website/index.html'), /Sign-in is not available yet/);
  assert.match(read('website/index.html'), /id="sign-in"/);
  assert.match(read('website/index.html'), /vendor\/auth0-spa-js-2\.30\.0\.js/);
  assert.doesNotMatch(read('website/auth0-gate.js'), /jsdelivr|cdn\./);
  assert.match(read('website/os/index.html'), /data-open="swarm" data-tool="monitor"/);
  assert.match(read('website/os/index.html'), /data-plan-panel/);
  assert.match(read('website/os/index.html'), /id="desktop" hidden/);
  assert.match(read('website/os/index.html'), /Wallet connect not configured yet/);
  assert.match(read('website/os/session.js'), /location\.replace\('\/'\)/);
  assert.match(read('website/app/index.html'), /auth-callback\.js/);
  assert.match(read('website/home-motion.js'), /hero-web\.mp4/);
  assert.match(read('website/home-motion.js'), /heaven-loop\.mp4/);
});
