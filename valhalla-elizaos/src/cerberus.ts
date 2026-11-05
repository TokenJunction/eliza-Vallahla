import type { Plugin } from '@elizaos/core';

const privilegedActions = new Set(['withdraw', 'transfer', 'trade', 'sign', 'export_key', 'post_social']);

async function auditBlock(action: string, reason: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url}/rest/v1/cerberus_vault_logs`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ action: action.slice(0, 200), outcome: 'blocked', reason, metadata: {} }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const cerberusPlugin: Plugin = {
  name: 'valhalla-cerberus',
  description: 'Vault guard: blocks every privileged action and records the attempt',
  routes: [
    {
      name: 'cerberus-check',
      path: '/api/valhalla/cerberus/check',
      type: 'POST',
      public: true,
      handler: async (request, response) => {
        const raw = (request as { body?: { action?: unknown } }).body?.action;
        const action = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!action) {
          response.status(400).json({ error: 'action_required' });
          return;
        }
        const reason = privilegedActions.has(action)
          ? 'privileged action disabled in paper mode'
          : 'unknown action denied by default';
        const audited = await auditBlock(action, reason);
        response.status(200).json({ outcome: 'blocked', action, reason, audited });
      },
    },
  ],
};

export default cerberusPlugin;
