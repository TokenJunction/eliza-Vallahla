// Shared live-session rule for the auth worker and the customer API.
// A signed payload is not enough. The server record must exist, match, and be unrevoked.
// Devices are optional. Email in a header or in the payload does not create a tenant.

export function sessionKey(sid) {
  return `sess:${sid}`;
}

export function acceptLive(record, claims, now = Date.now()) {
  if (!record || !claims) return null;
  if (record.revoked === true) return null;
  if (!claims.sid || record.sid !== claims.sid) return null;
  if (Number(record.ver) !== Number(claims.ver)) return null;
  if (!record.eh || record.eh !== claims.eh) return null;
  if (record.did && claims.did && record.did !== claims.did) return null;
  if (!Number.isFinite(Number(record.exp)) || Number(record.exp) < now) return null;
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < now) return null;
  return {
    sid: record.sid,
    ver: Number(record.ver),
    eh: record.eh,
    did: record.did || null,
    exp: Number(record.exp),
    code: record.code === true,
    google: record.google === true,
  };
}
