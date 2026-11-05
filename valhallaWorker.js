'use strict';

const { createValhallaQueueEngine } = require('./valhallaQueueEngine');

async function main() {
  const engine = await createValhallaQueueEngine();
  console.log('[Valhalla worker] Consuming Zeus, Gorgo and Cerberus queues (safe tasks only)');

  const shutdown = async () => {
    await engine.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(`[Valhalla worker] Failed to start: ${error.message}`);
  process.exit(1);
});
