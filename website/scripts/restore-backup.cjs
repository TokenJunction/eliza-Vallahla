'use strict';

const fs = require('node:fs');
const { openSnapshot } = require('./relay-core.cjs');

const file = process.argv[2];
const key = Buffer.from(String(process.env.BACKUP_ENC_KEY || ''), 'base64');
if (!file || key.length !== 32) {
  process.stderr.write('Set BACKUP_ENC_KEY and pass the snapshot file.\n');
  process.exit(1);
}
const restored = openSnapshot(fs.readFileSync(file, 'utf8'), key);
process.stdout.write(JSON.stringify(restored) + '\n');
