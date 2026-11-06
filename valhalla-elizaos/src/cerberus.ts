import type { Plugin } from '@elizaos/core';

export const cerberusPlugin: Plugin = {
  name: 'valhalla-cerberus',
  description: 'Vault guard: blocks every privileged action and records the attempt',
  routes: [
    {
      name: 'cerberus-check',
      path: '/api/valhalla/cerberus/check',
      type: 'POST',
      public: false,
      handler: async (request, response) => {
        const header = String((request as { headers?: { authorization?: string } }).headers?.authorization || "");
        if (!header.toLowerCase().startsWith("bearer ")) {
          response.status(401).json({ error: "auth_required" });
          return;
        }
        const raw = (request as { body?: { action?: unknown } }).body?.action;
        const action = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!action || action === "trade" || action === "sign") {
          response.status(403).json({ outcome: "blocked", error: "not_permitted" });
          return;
        }
        response.status(403).json({
          outcome: "blocked",
          action,
          reason: "privileged action disabled in paper mode",
        });
      },
    },
  ],
};

export default cerberusPlugin;
