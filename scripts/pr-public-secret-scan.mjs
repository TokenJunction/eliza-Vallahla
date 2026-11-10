import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PATTERNS = [
  { name: 'sk_live_/sk_test_', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'sb_secret_', re: /sb_secret_[A-Za-z0-9]{20,}/ },
  { name: 'hf_', re: /hf_[A-Za-z0-9]{30,}/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/ }
];

export function scanText(text) {
  const found = [];
  PATTERNS.forEach(function (pattern) {
    if (pattern.re.test(String(text || ''))) found.push(pattern.name);
  });
  return found;
}

function filesUnder(dir, list) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return list;
  }
  entries.forEach(function (name) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) filesUnder(path, list);
    else list.push(path);
  });
  return list;
}

export function publicFiles(root) {
  const base = root || 'website';
  const files = filesUnder(join(base, 'os'), []);
  filesUnder(base, []).forEach(function (path) {
    if (path.endsWith('.html')) files.push(path);
  });
  return Array.from(new Set(files));
}

export function scanPublicFiles(root) {
  const found = [];
  publicFiles(root).forEach(function (path) {
    const hits = scanText(readFileSync(path, 'utf8'));
    hits.forEach(function (name) { found.push(path + ': ' + name); });
  });
  return found;
}

function main() {
  const found = scanPublicFiles();
  const summary = found.length
    ? '### Public secret scan\n\nFailed:\n\n' + found.map(function (line) { return '- ' + line; }).join('\n') + '\n'
    : '### Public secret scan\n\nPassed. No live key, test key, service secret, Hugging Face token, private key, or bearer token in `website/os` or a public HTML file.\n';
  process.stdout.write(found.length ? 'public secret pattern found:\n' + found.join('\n') + '\n' : 'public secret scan passed\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (found.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
