import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanText } from './pr-public-secret-scan.mjs';

const live = 'sk_live_' + 'a'.repeat(20);
const testKey = 'sk_test_' + 'b'.repeat(20);
const service = 'sb_secret_' + 'c'.repeat(20);
const hugging = 'hf_' + 'd'.repeat(30);
const bearer = 'Bearer ' + 'e'.repeat(20);

function header(kind) {
  return '-----BEGIN ' + (kind ? kind + ' ' : '') + 'PRIVATE KEY-----';
}

test('ordinary words do not look like keys', () => {
  assert.deepEqual(scanText('risk_assessment skill_check hf_short sk_live_short'), []);
  assert.deepEqual(scanText('sk_test_' + 'a'.repeat(19)), []);
  assert.deepEqual(scanText('sb_secret_' + 'a'.repeat(19)), []);
  assert.deepEqual(scanText('hf_' + 'a'.repeat(29)), []);
  assert.deepEqual(scanText('Bearer short'), []);
  assert.deepEqual(scanText(header('DSA')), []);
});

test('real key shapes are rejected', () => {
  assert.ok(scanText(live).includes('sk_live_/sk_test_'));
  assert.ok(scanText(testKey).includes('sk_live_/sk_test_'));
  assert.ok(scanText(service).includes('sb_secret_'));
  assert.ok(scanText(hugging).includes('hf_'));
  assert.ok(scanText(header('')).includes('private key'));
  assert.ok(scanText(header('RSA')).includes('private key'));
  assert.ok(scanText(header('EC')).includes('private key'));
  assert.ok(scanText(header('OPENSSH')).includes('private key'));
  assert.ok(scanText(bearer).includes('bearer token'));
});

test('the workflow verifies gitleaks, stays shallow, and writes a summary', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
  assert.match(workflow, /jobs:\s*\n {2}pr-checks:/);
  assert.match(workflow, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(workflow, /sha256sum -c/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /fetch-depth: 1/);
  assert.doesNotMatch(workflow, /fetch-depth: 0/);
  assert.match(workflow, /base\.sha\}\.\.\.\$\{?HEAD|BASE\}\.\.\.\$\{HEAD/);
});
