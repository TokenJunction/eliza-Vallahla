import esbuild from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'site-build');
const hashFile = path.join(root, 'website/scripts/ship-canary-hashes.json');
const PLAIN_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA/,
  /pk_test_/,
  /sk_live/,
  /sb_secret_/,
  /sourceMappingURL/
];

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function loadCanaryHashes(file) {
  if (!file || !fs.existsSync(file)) throw new Error('ship canary hash file is missing');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('ship canary hash file is invalid');
  }
  const hashes = Array.isArray(parsed) ? parsed : parsed && parsed.hashes;
  if (!Array.isArray(hashes) || hashes.length === 0) throw new Error('ship canary hash file is empty');
  const clean = hashes.map(function (hash) { return String(hash).trim().toLowerCase(); }).filter(Boolean);
  if (!clean.length || clean.some(function (hash) { return !/^[0-9a-f]{64}$/.test(hash); })) {
    throw new Error('ship canary hash file is invalid');
  }
  return new Set(clean);
}

export function candidateTokens(text) {
  return String(text || '').match(/[A-Za-z0-9@][A-Za-z0-9@._+-]{2,}/g) || [];
}

export function hashCandidates(token) {
  const starts = [0];
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '.' || ch === '@' || ch === '+' || ch === '-') starts.push(i + 1);
  }
  const out = [];
  for (const start of starts) {
    for (let end = start + 3; end <= token.length; end += 1) {
      out.push(token.slice(start, end));
    }
  }
  return out;
}

export function scanShipped(text, hashes) {
  for (const pattern of PLAIN_PATTERNS) {
    if (pattern.test(text)) return 'pattern';
  }
  for (const token of candidateTokens(text)) {
    for (const candidate of hashCandidates(token)) {
      if (hashes.has(sha256(candidate))) return 'hash';
    }
  }
  return '';
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

export async function minifySite(directory = out, hashesPath = hashFile) {
  const hashes = loadCanaryHashes(hashesPath);
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
  for (const file of shipped) {
    if (scanShipped(fs.readFileSync(file, 'utf8'), hashes)) throw new Error(path.relative(directory, file) + ' contains a forbidden ship canary');
  }
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
