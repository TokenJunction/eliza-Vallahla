const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const homeSource = fs.readFileSync(path.join(root, 'website/home.js'), 'utf8');

test('homepage continue stores the return preference and opens sign-in', () => {
  assert.match(homeSource, /Sign-in is not available yet/);
  assert.doesNotMatch(homeSource, /\/app\/|valhalla-entry-email|valhalla-auth/);
});

test('blocked storage does not pretend the entrance completed sign-in', () => {
  assert.match(homeSource, /catch\(unavailable\)/);
  assert.doesNotMatch(homeSource, /sessionStorage/);
});

test('entrance and volOS copy stay honest', () => {
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const volos = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.match(home, /Sign-in is not available yet/);
  assert.match(home, /id="clerk-sign-in"/);
  assert.match(home, /\/assets\/heaven-poster\.jpg/);
  assert.doesNotMatch(home, /Trade Solana|Public desk|Preview the public|Continue to sign-in|github\.com/);
  const desk = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  for (const text of [home, volos, desk]) {
    assert.doesNotMatch(text, /enterWorkstationSession|keene\.jos|operator-01@|Valhalla2033|pk_test_/);
  }
  assert.match(desk, /data-open="wallet"/);
  assert.match(desk, /LIVE TRADING OFF/);
  assert.match(desk, /disabled/);
  assert.match(desk, /id="desktop" hidden/);
  assert.doesNotMatch(desk, /data-enter-desk|PUBLIC DESK|href="\/os\/"/);
  assert.match(fs.readFileSync(path.join(root, 'website/os/session.js'), 'utf8'), /location\.replace\('\/'\)/);
  const css = fs.readFileSync(path.join(root, 'website/home.css'), 'utf8');
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(min-width: 1024px\)/);
  const mobile = fs.readFileSync(path.join(root, 'website/os/os.css'), 'utf8').split('@media (max-width: 720px)')[1];
  assert.doesNotMatch(mobile, /top:\s*118px/);
  assert.doesNotMatch(mobile, /z-index:\s*\d+\s*!important/);
  assert.match(mobile, /\.menu-bar,\s*\.dock\s*\{\s*z-index:\s*1/);
  assert.match(volos, /Not published/);
  assert.match(volos, /can fall to zero/);
  assert.match(volos, /https:\/\/valhalla-app\.xyz\//);
  assert.doesNotMatch(volos, /pump\.fun/i);
  assert.doesNotMatch(volos, /will pump/i);
  assert.doesNotMatch(volos, /0x[0-9a-fA-F]{40}/);
});
