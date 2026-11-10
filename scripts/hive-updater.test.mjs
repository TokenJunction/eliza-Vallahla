import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  FALLBACK_MS,
  acceptRelease,
  healthReport,
  retainKnownGood,
  selectRepairSource,
  signRelease
} from './hive-updater.mjs';

const root = path.join(import.meta.dirname, '..');
const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function customer() {
  return { id: 'node-a', role: 'customer', channel: 'akershus', version: '1.0.0', knownGood: [], healthy: true, alive: true };
}

function release(overrides = {}) {
  return signRelease({
    channel: 'akershus',
    path: 'akershus/system',
    version: '1.0.1',
    category: 'system',
    files: [{ name: 'desk.js', text: 'ordinary system patch' }],
    issuedAt: 1,
    ...overrides
  }, keys.privateKey);
}

test('a customer node cannot apply a Zeus artifact', () => {
  const result = acceptRelease(customer(), release({
    channel: 'zeus',
    path: 'zeus/overseer',
    files: [{ name: 'zeus_overseer.js', text: 'overseer portal' }]
  }), keys.publicKey, 10_000);
  assert.equal(result.applied, false);
  assert.match(result.reason, /wrong channel or role/);
  assert.equal(result.node.version, '1.0.0');
});

test('Akershus rejects Zeus material even when the channel label is customer', () => {
  const result = acceptRelease(customer(), release({
    files: [{ name: 'notes.txt', text: 'zeus_overseer and owner wallet person@example.test' }]
  }), keys.publicKey, 10_000);
  assert.equal(result.applied, false);
  assert.match(result.reason, /Akershus refused/);
});

test('a node rejects a mismatched role, a wrong path, and an unsigned release', () => {
  const wrongRole = acceptRelease(
    { ...customer(), role: 'overseer', channel: 'zeus' },
    release(),
    keys.publicKey,
    10_000
  );
  assert.match(wrongRole.reason, /wrong channel or role/);

  const wrongPath = acceptRelease(customer(), release({ path: 'zeus/system' }), keys.publicKey, 10_000);
  assert.equal(wrongPath.reason, 'wrong path');

  const unsigned = acceptRelease(customer(), { ...release(), signature: '' }, keys.publicKey, 10_000);
  assert.match(unsigned.reason, /unsigned/);

  const wrongKey = acceptRelease(customer(), release(), other.publicKey, 10_000);
  assert.match(wrongKey.reason, /unsigned or wrong signature/);
});

test('ordinary patches auto-accept and gated changes do not', () => {
  const ordinary = acceptRelease(customer(), release({ category: 'atmosphere', version: '1.0.2' }), keys.publicKey, 1_000);
  assert.equal(ordinary.applied, true);
  assert.equal(ordinary.autoAccept, true);
  assert.equal(ordinary.node.version, '1.0.2');

  for (const category of ['login', 'trading', 'dns', 'secrets', 'production-merge']) {
    const gated = acceptRelease(customer(), release({ category, version: '9.9.9' }), keys.publicKey, 2_000);
    assert.equal(gated.applied, false, category);
    assert.equal(gated.autoAccept, false, category);
    assert.equal(gated.node.version, '1.0.0', category);
  }
});

test('known-good versions stay available for at least 3 hours', () => {
  const now = 10_000_000;
  const first = acceptRelease(customer(), release({ version: '1.0.1', issuedAt: 1 }), keys.publicKey, now);
  const second = acceptRelease(first.node, release({ version: '1.0.2', issuedAt: 2 }), keys.publicKey, now + 60 * 60 * 1000);
  const stillKept = retainKnownGood(second.node.knownGood, now + FALLBACK_MS);
  assert.equal(stillKept.some(entry => entry.version === '1.0.1'), true);
  const expired = retainKnownGood(second.node.knownGood, now + FALLBACK_MS + 1);
  assert.equal(expired.some(entry => entry.version === '1.0.1'), false);
  assert.equal(expired.some(entry => entry.version === '1.0.2'), true);
});

test('an older signed ordinary patch cannot move the node backward', () => {
  const now = 50_000;
  const current = acceptRelease(customer(), release({ version: '1.0.2', issuedAt: 20 }), keys.publicKey, now);
  assert.equal(current.applied, true);
  const older = acceptRelease(current.node, release({ version: '1.0.1', issuedAt: 10 }), keys.publicKey, now + 1);
  assert.equal(older.applied, false);
  assert.equal(older.node.version, '1.0.2');
  const sameVersion = acceptRelease(current.node, release({ version: '1.0.2', issuedAt: 30 }), keys.publicKey, now + 2);
  assert.equal(sameVersion.reason, 'not a newer version');
  const replayedTime = acceptRelease(current.node, release({ version: '1.0.3', issuedAt: 20 }), keys.publicKey, now + 3);
  assert.equal(replayedTime.reason, 'older or unsigned release time');
  assert.equal(replayedTime.node.version, '1.0.2');
});

test('only a live node on the same channel can be a repair source', () => {
  const nodes = [
    { id: 'self', channel: 'akershus', healthy: true, alive: true },
    { id: 'zeus-node', channel: 'zeus', healthy: true, alive: true },
    { id: 'down', channel: 'akershus', healthy: false, alive: true },
    { id: 'peer', channel: 'akershus', healthy: true, alive: true }
  ];
  assert.equal(selectRepairSource(nodes, 'akershus', 'self').id, 'peer');
  assert.equal(selectRepairSource(nodes, 'zeus', 'zeus-node'), null);
});

test('the public health file does not claim the updater is live', () => {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'website/updates/health.json'), 'utf8'));
  const report = healthReport(null);
  assert.equal(file.live, false);
  assert.equal(file.updater, 'not-connected');
  assert.deepEqual(file.channels, report.channels);
  assert.equal(healthReport({ ok: true, updater: 'running', checkedAt: 5 }).live, true);
  const page = fs.readFileSync(path.join(root, 'website/updates/index.html'), 'utf8');
  assert.match(page, /not connected/i);
  assert.doesNotMatch(page, /updater is live/i);
});

test('Akershus launchers do not pull Zeus or an auth bypass', () => {
  const names = [
    'START-VALHALLA-OS.bat',
    'Update-ValhallaOS.bat',
    'Stop-ValhallaOS.bat',
    'ValhallaOS-Akershus-Setup.bat',
    'ValhallaOS-Akershus-Master-Installer.bat'
  ];
  for (const name of names) {
    const text = fs.readFileSync(path.join(root, 'windows-shell', name), 'utf8');
    assert.match(text, /Akershus/);
    assert.doesNotMatch(text, /zeus|auth=|operator-01@|pk_test_|sk_live_/i);
    if (name !== 'Stop-ValhallaOS.bat') {
      assert.match(text, /https:\/\/valhalla-app\.xyz\/os\/|START-VALHALLA-OS\.bat/);
    }
  }
});
