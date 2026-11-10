import esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'site-build');
const hashFile = path.join(root, 'website/scripts/ship-canary-hashes.txt');
const localCanaries = path.join(root, 'website/scripts/ship-canaries.local');

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function committedCanaryHashes(text) {
  return String(text || '').split('\n').map(function (line) { return line.trim(); }).filter(function (line) { return line && !line.startsWith('#'); });
}

export function verifiedCanaries(values, hashes) {
  if (values == null) return [];
  const actual = values.map(sha256).sort();
  const expected = hashes.slice().sort();
  if (actual.length !== expected.length || actual.some(function (hash, index) { return hash !== expected[index]; })) {
    throw new Error('ship canary file does not match the committed hashes');
  }
  return values;
}

export function readCanaryValues(env = process.env, file = localCanaries) {
  if (env && env.VALHALLA_SHIP_CANARIES && String(env.VALHALLA_SHIP_CANARIES).trim()) {
    return String(env.VALHALLA_SHIP_CANARIES).split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  }
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  }
  return null;
}

export async function minifySource(code, loader) {
  const result = await esbuild.transform(code, {
    loader,
    minify: true,
    minifyIdentifiers: true,
    legalComments: 'none',
    sourcemap: false,
    target: 'es2020',
    drop: ['console', 'debugger'],
    mangleProps: /^_/,
    mangleQuoted: false
  });
  if (result.map) throw new Error('source map was produced');
  return result.code;
}

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function checkPublic(text, file, canaries) {
  for (const item of canaries) {
    if (item && text.includes(item)) throw new Error(file + ' contains a forbidden ship canary');
  }
}

export async function minifySite(directory = out) {
  if (!fs.existsSync(directory)) throw new Error('missing build directory');
  const files = walk(directory);
  for (const file of files) {
    if (file.endsWith('.map') || file.endsWith('.env') || path.basename(file).startsWith('.env')) {
      throw new Error('refusing to ship ' + file);
    }
  }
  for (const file of files) {
    if (file.endsWith('.min.js')) continue;
    if (file.endsWith('.js')) {
      const code = await minifySource(fs.readFileSync(file, 'utf8'), 'js');
      fs.writeFileSync(file, code);
    } else if (file.endsWith('.css')) {
      const code = await minifySource(fs.readFileSync(file, 'utf8'), 'css');
      fs.writeFileSync(file, code);
    } else if (file.endsWith('.html')) {
      fs.writeFileSync(file, minifyHtml(fs.readFileSync(file, 'utf8')));
    }
  }
  const shipped = walk(directory).filter(file => /\.(html|js|css)$/.test(file));
  const canaries = verifiedCanaries(readCanaryValues(), committedCanaryHashes(fs.readFileSync(hashFile, 'utf8')));
  for (const file of shipped) checkPublic(fs.readFileSync(file, 'utf8'), path.relative(directory, file), canaries);
  const appJs = path.join(directory, 'os', 'app.js');
  if (fs.existsSync(appJs) && fs.readFileSync(appJs, 'utf8').includes('function vho' + '0')) {
    throw new Error('padding trail was shipped');
  }
  const workstation = ['os/index.html', 'os/app.js', 'os/bridge.js', 'os/os.css', 'desk.js', 'desk.css']
    .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
  if (workstation >= 1500000) throw new Error('workstation bundle is too large');
  if (files.some(file => file.includes('private-export') || file.endsWith('.tar.gz'))) {
    throw new Error('private pack reached the public build');
  }
  return { trailBytes: 0, workstation };
}

function minifyHtml(html) {
  const blocks = [];
  const token = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<pre\b[^>]*>[\s\S]*?<\/pre>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, match => {
    blocks.push(match);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const compact = token
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
  return compact.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = await minifySite();
  process.stdout.write(JSON.stringify(result) + '\n');
}
