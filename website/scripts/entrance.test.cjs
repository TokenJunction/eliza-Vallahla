const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { entranceConfig } = require('./entrance-config.cjs');
const account = require('../account-level.js');

const root = path.join(__dirname, '../..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('development Clerk keys are not a production entrance', () => {
  assert.deepEqual(entranceConfig({}), { clerk: 'not-configured', publishableKey: '' });
  assert.deepEqual(entranceConfig({ CLERK_PUBLISHABLE_KEY: 'pk_test_example' }), { clerk: 'not-configured', publishableKey: '' });
  assert.equal(entranceConfig({ CLERK_PUBLISHABLE_KEY: 'pk_live_example' }).clerk, 'production');
  assert.equal(JSON.stringify(entranceConfig({ CLERK_PUBLISHABLE_KEY: 'pk_test_example' })).includes('pk_test_'), false);
});

test('missing plans stay FREE and named plans are read from Clerk metadata', () => {
  const unset = account.levelFromUser({});
  assert.equal(unset.level, 'FREE');
  assert.equal(unset.configured, false);
  assert.match(unset.note, /Plans are not configured/);
  assert.equal(account.levelFromUser({ publicMetadata: { plan: 'pro' } }).level, 'PRO');
  assert.equal(account.levelFromUser({ publicMetadata: { features: ['unlimited'] } }).level, 'UNLIMITED');
  assert.equal(account.toolAllowed('FREE', 'wallet'), true);
  assert.equal(account.toolAllowed('FREE', 'monitor'), false);
  assert.equal(account.toolAllowed('UNLIMITED', 'monitor'), true);
  assert.equal(account.toolAllowed('PRO', 'swap'), false);
});

test('public pages do not offer the paper desk or the repository', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html') || entry.name.endsWith('.js')) files.push(full);
    }
  }
  walk(path.join(root, 'website'));
  const blob = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(blob, /github\.com\/TokenJunction/);
  assert.doesNotMatch(blob, /Public desk|Preview the public paper desk|Explore the public ValhallaOS desk/);
  assert.match(read('website/index.html'), /Sign-in is not available yet/);
  assert.match(read('website/os/index.html'), /id="desktop" hidden/);
  assert.match(read('website/os/session.js'), /location\.replace\('\/'\)/);
  assert.match(read('website/home-motion.js'), /hero-web\.mp4/);
  assert.match(read('website/home-motion.js'), /heaven-loop\.mp4/);
  assert.match(read('website/home-motion.js'), /prefers-reduced-motion: reduce/);
});
