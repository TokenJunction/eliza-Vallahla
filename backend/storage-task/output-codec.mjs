import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonical, fail } from './canonical.mjs';

// Server-managed 32-byte encryption key, NOT API keys or an auth session token.
// Stable across replicas/restarts; use a keyring/versioned envelope for rotation in integration.
export function createOutputCodec(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('encryption_key_unavailable', 503);
  const aad = ({ scope, taskId }) => Buffer.from(canonical([scope.tenantId, scope.subject, taskId]));
  return {
    seal(text, context) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(context));
      const payload = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), payload.toString('base64url')].join('.');
    },
    open(envelope, context) {
      const [v, iv, tag, payload, extra] = String(envelope).split('.');
      if (v !== 'v1' || !iv || !tag || !payload || extra) fail('invalid_envelope', 503);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(aad(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
