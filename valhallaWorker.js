'use strict';

const { checkStructure, checkWorkerConfig } = require('./scripts/workerPreflight');
const { createValhallaQueueEngine } = require('./valhallaQueueEngine');

async function main() {
  checkStructure();
  if (!checkWorkerConfig()) {
    console.log(JSON.stringify({ component: 'worker', status: 'disabled', ready: false }));
    return;
  }

  const controller = new AbortController();
  let engine;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    const timer = setTimeout(() => {
      console.error(JSON.stringify({ component: 'worker', error: 'shutdown_timeout' }));
      process.exit(1);
    }, 10000);
    try {
      if (engine) await engine.close();
    } finally {
      clearTimeout(timer);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown().catch(() => {
        console.error(JSON.stringify({ component: 'worker', error: 'shutdown_failed' }));
        process.exitCode = 1;
      });
    });
  }
  try {
    engine = await createValhallaQueueEngine({
      role: 'consumer',
      signal: controller.signal,
      onState: (state) => console.log(JSON.stringify({ component: 'worker', ...state })),
    });
    if (stopping) await engine.close();
  } catch (error) {
    if (!stopping) {
      console.error(JSON.stringify({ component: 'worker', error: ['startup_timeout', 'redis_unavailable'].includes(error.message) ? error.message : 'startup_failed' }));
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(JSON.stringify({ component: 'worker', error: 'invalid_configuration' }));
    process.exitCode = 1;
  });
}

module.exports = { main };
