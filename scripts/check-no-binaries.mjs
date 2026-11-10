import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSIONS = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'pyc', 'class', 'jar', 'wasm', 'node', 'com']);

export function forbiddenReason(filePath, head) {
  const name = String(filePath || '');
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (EXTENSIONS.has(extension)) return 'forbidden extension';
  const bytes = Buffer.from(head || []);
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return 'ELF';
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return 'PE';
  if (bytes.length >= 4) {
    const magic = bytes.subarray(0, 4).toString('hex');
    if (magic === 'feedface' || magic === 'feedfacf' || magic === 'cefaedfe' || magic === 'cffaedfe' || magic === 'cafebabe' || magic === 'cafebabf') return 'Mach-O';
  }
  return '';
}

function allowlist() {
  const text = readFileSync(new URL('./binary-allowlist.txt', import.meta.url), 'utf8');
  return new Set(text.split('\n').map(function (line) { return line.split('#')[0].trim(); }).filter(Boolean));
}

export function scanTracked(root) {
  const allowed = allowlist();
  const cwd = root || process.cwd();
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: cwd, encoding: 'utf8' });
  const found = [];
  listed.split('\0').filter(Boolean).forEach(function (file) {
    if (allowed.has(file)) return;
    const head = Buffer.alloc(4);
    let fd;
    try {
      fd = openSync(join(cwd, file), 'r');
      readSync(fd, head, 0, 4, 0);
    } catch (error) {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const reason = forbiddenReason(file, head);
    if (reason) found.push(file + ': ' + reason);
  });
  return found;
}

function main() {
  const found = scanTracked();
  if (!found.length) {
    process.stdout.write('no committed executables\n');
    return;
  }
  process.stderr.write(found.join('\n') + '\n');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
