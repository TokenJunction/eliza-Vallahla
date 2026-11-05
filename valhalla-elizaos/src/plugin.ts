import type { Plugin } from '@elizaos/core';

export const valhallaStatusPlugin: Plugin = {
  name: 'valhalla-status',
  description: 'Public health and disabled-capability status for Valhalla',
  routes: [
    {
      name: 'valhalla-health',
      path: '/api/valhalla/health',
      type: 'GET',
      public: true,
      handler: async (_request, response) => {
        response.status(200).json({
          status: 'ok',
          service: 'valhalla-elizaos',
          mode: 'paper',
          capabilities: {
            trading: 'disabled',
            privateKeyStorage: 'disabled',
            socialDispatch: 'disabled',
            vaultActions: 'disabled',
            zeusIdleJobs: 'disabled',
            perUserSandboxProvisioning: 'not_configured',
          },
        });
      },
    },
  ],
};

export default valhallaStatusPlugin;
