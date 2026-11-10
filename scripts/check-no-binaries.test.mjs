import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenReason, scanTracked } from './check-no-binaries.mjs';

test('compiled binaries are rejected and text is not', () => {
  assert.equal(forbiddenReason('notes.md', Buffer.from('hello')), '');
  assert.equal(forbiddenReason('tool.exe', Buffer.from('text')), 'forbidden extension');
  assert.equal(forbiddenReason('app', Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'ELF');
  assert.equal(scanTracked(new URL('..', import.meta.url).pathname).length, 0);
});
