import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const HEADER = '<!--\nCopyright (c) 2026 TokenJunction LLC\nSPDX-License-Identifier: MIT\n-->\n';
const files = execFileSync('git', ['ls-files', '*.html'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const updated = [];
const skipped = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('SPDX-License-Identifier')) continue;
  const end = text.indexOf('\n');
  if (end < 0) { skipped.push(file + ' (no newline)'); continue; }
  const first = text.slice(0, end).replace(/^\uFEFF/, '');
  if (!/^<!doctype html>\s*$/i.test(first)) { skipped.push(file + ' (no doctype)'); continue; }
  writeFileSync(file, text.slice(0, end + 1) + HEADER + text.slice(end + 1));
  updated.push(file);
}
process.stdout.write('headers added: ' + updated.length + '\n');
if (skipped.length) process.stdout.write('skipped: ' + skipped.join(', ') + '\n');
