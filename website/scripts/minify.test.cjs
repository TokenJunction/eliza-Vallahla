const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('production transform keeps desk hooks, drops console, and ships no padding trail', async () => {
  const { minifySource, sha256, scanShipped, loadCanaryHashes } = await import('./minify-site.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../os/app.js'), 'utf8');
  const minified = await minifySource(source, 'js');
  assert.match(minified, /getElementById\("desktop"\)|getElementById\('desktop'\)/);
  assert.match(minified, /dataset\.open/);
  assert.doesNotMatch(minified, /sourceMappingURL/);
  assert.doesNotMatch(minified, /function vho/);
  const dropped = await minifySource('console.log("secret-log"); debugger; var keep = { _hidden: 1, open: 2 }; keep._hidden; keep.open;', 'js');
  assert.doesNotMatch(dropped, /console/);
  assert.doesNotMatch(dropped, /debugger/);
  assert.doesNotMatch(dropped, /_hidden/);
  assert.match(dropped, /open/);
  const committed = loadCanaryHashes(path.join(__dirname, 'ship-canary-hashes.json'));
  assert.ok(committed.size > 0);
  const sample = 'canary-sample';
  const hashes = new Set([sha256(sample)]);
  assert.equal(scanShipped('safe page', hashes), '');
  assert.equal(scanShipped('token ' + sample + ' end', hashes), 'hash');
  const host = 'local.name';
  const mailbox = 'pre-fix@';
  const prefixed = new Set([sha256(host), sha256(mailbox)]);
  assert.equal(scanShipped('see ' + host + '@mail.test', prefixed), 'hash');
  assert.equal(scanShipped('see user.' + host + '.example', prefixed), 'hash');
  assert.equal(scanShipped('see ' + mailbox + 'host.example', prefixed), 'hash');
  assert.equal(scanShipped('see other-name@mail.test', prefixed), '');
  assert.equal(scanShipped('pk_test_example', hashes), 'pattern');
  const core = fs.readFileSync(path.join(__dirname, 'minify-site.mjs'), 'utf8');
  assert.doesNotMatch(core, /generateTrail/);
  assert.match(core, /ship-canary-hashes\.json/);
  assert.doesNotMatch(core, /VALHALLA_SHIP_CANARIES/);
});

test('a missing hash file fails the build', async () => {
  const { minifySite } = await import('./minify-site.mjs');
  const dir = fs.mkdtempSync(path.join(__dirname, 'canary-missing-'));
  fs.writeFileSync(path.join(dir, 'page.js'), 'var ok = 1;\n');
  await assert.rejects(() => minifySite(dir, path.join(dir, 'missing.json')), /ship canary hash file is missing/);
  fs.writeFileSync(path.join(dir, 'empty.json'), '{"hashes":[]}\n');
  await assert.rejects(() => minifySite(dir, path.join(dir, 'empty.json')), /ship canary hash file is empty/);
  fs.rmSync(dir, { recursive: true, force: true });
});
