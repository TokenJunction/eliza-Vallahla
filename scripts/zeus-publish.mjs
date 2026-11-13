import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { signRelease } from './hive-updater.mjs';

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

export async function publishRelease(options) {
  const relayUrl = required(options.relayUrl, 'relayUrl').replace(/\/+$/, '');
  const privateKey = options.privateKey;
  const release = options.release;
  if (!privateKey) throw new Error('A release private key is required.');
  if (!release || typeof release !== 'object') throw new Error('A release is required.');
  const signed = signRelease(release, privateKey);
  const response = await (options.fetchImpl || fetch)(`${relayUrl}/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    body: JSON.stringify(signed)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `relay returned HTTP ${response.status}`);
  return { release: signed, response: body };
}

async function main() {
  const { values } = parseArgs({
    options: {
      relay: { type: 'string' },
      key: { type: 'string' },
      token: { type: 'string' },
      channel: { type: 'string' },
      path: { type: 'string' },
      version: { type: 'string' },
      category: { type: 'string' },
      'issued-at': { type: 'string' },
      file: { type: 'string', multiple: true },
      manifest: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }
    }
  });

  const base = values.manifest
    ? JSON.parse(await readFile(values.manifest, 'utf8'))
    : {};
  const release = {
    channel: values.channel || base.channel,
    path: values.path || base.path,
    version: values.version || base.version,
    category: values.category || base.category,
    issuedAt: values['issued-at'] ? Number(values['issued-at']) : Number(base.issuedAt || Math.floor(Date.now() / 1000)),
    files: Array.isArray(base.files) ? [...base.files] : []
  };

  for (const entry of values.file || []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error('--file must be name=path');
    const name = entry.slice(0, separator);
    const file = entry.slice(separator + 1);
    release.files.push({ name, text: await readFile(file, 'utf8') });
  }

  if (!release.channel || !release.path || !release.version || !release.category) {
    throw new Error('channel, path, version, and category are required.');
  }
  if (!release.files.length) throw new Error('At least one --file or manifest file is required.');
  if (!Number.isSafeInteger(release.issuedAt) || release.issuedAt <= 0) throw new Error('issuedAt must be a positive integer.');

  const privateKey = await readFile(required(values.key, '--key'), 'utf8');
  if (values['dry-run']) {
    console.log(JSON.stringify(signRelease(release, privateKey), null, 2));
    return;
  }

  const result = await publishRelease({
    relayUrl: required(values.relay, '--relay'),
    privateKey,
    token: values.token,
    release
  });
  console.log(JSON.stringify({
    ok: true,
    channel: result.response.channel,
    version: result.response.version,
    issuedAt: result.response.issuedAt,
    nodes: result.response.nodes
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[zeus-publish] ${error.message}`);
    process.exit(1);
  });
}
