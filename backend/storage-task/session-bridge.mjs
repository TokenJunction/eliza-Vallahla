// Maps a server-side worker grant into the task-store auth shape.
// The public /auth/access body is not this grant. Worker role is ignored.
// This does not call Supabase or a model provider.

const EMAIL_HASH = /^[0-9a-f]{64}$/;

export function validateWorkerIdentity(body, now = Date.now()) {
  if (!body || body.ok !== true) return { verified: false, reason: 'proof' };
  if (body.email_verified !== true) return { verified: false, reason: 'email_verified' };
  if (!EMAIL_HASH.test(String(body.subject || ''))) return { verified: false, reason: 'subject' };
  if (!body.sid) return { verified: false, reason: 'sid' };
  return {
    verified: true,
    tenantId: body.subject,
    subject: body.subject,
    sessionId: String(body.sid),
    sessionRole: 'member',
    authVersion: 1,
    expiresAt: now + 60_000,
    supabaseAuthUid: null,
    workerRoleIgnored: body.role === 'admin' || body.leader === true,
  };
}
