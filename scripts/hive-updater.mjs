import { sign, verify } from 'node:crypto';

export const FALLBACK_MS = 3 * 60 * 60 * 1000;

export const CHANNELS = {
  akershus: { role: 'customer', pathPrefix: 'akershus/' },
  zeus: { role: 'overseer', pathPrefix: 'zeus/' }
};

export const ORDINARY = new Set(['system', 'atmosphere']);
export const GATED = new Set(['login', 'trading', 'dns', 'secrets', 'production-merge']);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function canonical(release) {
  return JSON.stringify({
    category: release.category,
    channel: release.channel,
    files: release.files || [],
    issuedAt: release.issuedAt,
    path: release.path,
    version: release.version
  });
}

export function signRelease(release, privateKey) {
  const body = canonical(release);
  const signature = sign(null, Buffer.from(body), privateKey).toString('base64url');
  return { ...release, signature };
}

export function verifyRelease(release, publicKey) {
  if (!release || typeof release.signature !== 'string' || !release.signature) return false;
  try {
    return verify(null, Buffer.from(canonical(release)), publicKey, Buffer.from(release.signature, 'base64url'));
  } catch (error) {
    return false;
  }
}

function forbiddenAkershus(release) {
  const blob = [release.path, ...(release.files || []).map(file => `${file.name}\n${file.text || ''}`)].join('\n');
  if (/zeus_overseer/i.test(blob)) return 'zeus_overseer';
  if (/overseer portal/i.test(blob)) return 'overseer portal';
  if (/owner wallet/i.test(blob)) return 'owner wallet';
  if (EMAIL.test(blob)) return 'email';
  if (/\bzeus\b/i.test(blob)) return 'zeus copy';
  return '';
}

export function retainKnownGood(entries, now) {
  return (entries || []).filter(entry => now - entry.acceptedAt <= FALLBACK_MS);
}

export function selectRepairSource(nodes, channel, selfId) {
  return (nodes || []).find(node =>
    node
    && node.id !== selfId
    && node.channel === channel
    && node.healthy === true
    && node.alive === true
  ) || null;
}

export function healthReport(probe) {
  if (probe && probe.ok === true && probe.updater === 'running' && typeof probe.checkedAt === 'number') {
    return { updater: 'running', live: true, checkedAt: probe.checkedAt, channels: ['akershus', 'zeus'] };
  }
  return {
    updater: 'not-connected',
    live: false,
    reason: 'No updater process reported a successful health probe.',
    channels: ['akershus', 'zeus']
  };
}

export function acceptRelease(node, release, publicKey, now) {
  const current = { ...node, knownGood: retainKnownGood(node.knownGood, now) };
  if (!verifyRelease(release, publicKey)) {
    return { applied: false, autoAccept: false, reason: 'unsigned or wrong signature', node: current };
  }
  const channel = CHANNELS[release.channel];
  if (!channel || current.channel !== release.channel || current.role !== channel.role) {
    return { applied: false, autoAccept: false, reason: 'wrong channel or role', node: current };
  }
  if (typeof release.path !== 'string' || !release.path.startsWith(channel.pathPrefix)) {
    return { applied: false, autoAccept: false, reason: 'wrong path', node: current };
  }
  if (release.channel === 'akershus') {
    const blocked = forbiddenAkershus(release);
    if (blocked) return { applied: false, autoAccept: false, reason: 'Akershus refused ' + blocked, node: current };
  }
  if (!ORDINARY.has(release.category) || GATED.has(release.category)) {
    return { applied: false, autoAccept: false, reason: 'gated change needs review', node: current };
  }
  const knownGood = retainKnownGood([
    ...current.knownGood,
    { version: release.version, path: release.path, channel: release.channel, acceptedAt: now }
  ], now);
  return {
    applied: true,
    autoAccept: true,
    reason: 'ordinary patch accepted',
    node: { ...current, version: release.version, knownGood }
  };
}
