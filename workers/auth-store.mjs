// Single-writer account store. This is the preview stand-in for a Durable Object
// keyed by the mailbox hash. It is not a production binding and it is not billed here.
// KV may cache counters. It is not the authority for sessions, codes, or revokes.

export const TOKEN_ISS = "https://auth.valhalla-app.xyz";
export const TOKEN_AUD = "valhalla-api";
export const TOKEN_PURPOSE = "access";
export const IDLE_MS = 30 * 60 * 1000;

export function createAuthStore() {
  let chain = Promise.resolve();
  const sessions = new Map();
  const codes = new Map();
  const humans = new Map();

  function run(fn) {
    const job = chain.then(fn, fn);
    chain = job.then(() => undefined, () => undefined);
    return job;
  }

  const store = {
    consistent: true,
    seed(record) {
      const version = record.v || 1;
      sessions.set(record.sid, {
        ...record,
        v: version,
        lastSeen: record.lastSeen || Date.now(),
      });
    },
    putSession(record) {
      return run(() => {
        store.seed(record);
        return sessions.get(record.sid);
      });
    },
    readSession(claims, now = Date.now()) {
      return run(() => {
        if (store.consistent === false) return null;
        if (!claims || claims.iss !== TOKEN_ISS || claims.aud !== TOKEN_AUD || claims.purpose !== TOKEN_PURPOSE) return null;
        const claimed = Number(claims.sv ?? claims.ver);
        const row = sessions.get(claims.sid);
        if (!row || row.eh !== claims.eh || row.did !== claims.did || row.v !== claimed) return null;
        if (Number(row.exp) < now) return null;
        if (now - Number(row.lastSeen) > IDLE_MS) return null;
        row.lastSeen = now;
        return {
          eh: row.eh,
          did: row.did,
          sid: row.sid,
          ver: row.v,
          exp: row.exp,
          code: row.code === true,
          google: row.google === true,
        };
      });
    },
    revokeDevice(eh, did) {
      return run(() => {
        let removed = 0;
        for (const [sid, row] of sessions) {
          if (row.eh === eh && row.did === did) {
            sessions.delete(sid);
            removed += 1;
          }
        }
        if (!removed) return { ok: false };
        return { ok: true, removed };
      });
    },
    putCode(key) {
      return run(() => {
        if (!codes.has(key)) codes.set(key, { used: false });
      });
    },
    consumeCode(key) {
      return run(() => {
        const row = codes.get(key);
        if (!row || row.used) return false;
        row.used = true;
        return true;
      });
    },
    bindHuman(id, scope) {
      return run(() => {
        if (humans.has(id)) return false;
        humans.set(id, { ...scope, at: Date.now() });
        return true;
      });
    },
  };
  return store;
}

export function asReplica(store) {
  return {
    consistent: false,
    async readSession() {
      return null;
    },
    async putSession(record) {
      return store.putSession(record);
    },
    async revokeDevice(eh, did) {
      return store.revokeDevice(eh, did);
    },
  };
}
