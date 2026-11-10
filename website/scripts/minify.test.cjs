const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('production transform keeps desk hooks, drops console, and ships no padding trail', async () => {
  const { minifySource, verifiedCanaries, sha256 } = await import('./minify-site.mjs');
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
  const sample = 'canary-sample';
  assert.throws(() => verifiedCanaries([sample], [sha256('other')]), /committed hashes/);
  assert.deepEqual(verifiedCanaries([sample], [sha256(sample)]), [sample]);
  const core = fs.readFileSync(path.join(__dirname, 'minify-site.mjs'), 'utf8');
  assert.doesNotMatch(core, /generateTrail/);
  assert.match(core, /ship-canary-hashes\.txt/);
  assert.doesNotMatch(core, /contains a forbidden ship canary' \+/);
});
