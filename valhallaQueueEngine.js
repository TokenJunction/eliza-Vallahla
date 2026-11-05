'use strict';

const { timingSafeEqual } = require('node:crypto');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');

const QUEUE_TASKS = Object.freeze({
  zeus: new Set(['health-check', 'policy-check']),
  gorgo: new Set(['sandbox-health', 'paper-simulation']),
  cerberus: new Set(['vault-check']),
});
const MAX_PAYLOAD_BYTES = 4096;

function validateDispatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('request_must_be_an_object');
  }

  const { targetEngine, taskName, payload = {} } = input;
  if (!Object.hasOwn(QUEUE_TASKS, targetEngine) || !QUEUE_TASKS[targetEngine].has(taskName)) {
    throw new TypeError('unsupported_queue_task');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload_must_be_an_object');
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    throw new TypeError('payload_too_large');
  }

  const allowedPayloadKeys = {
    'zeus:health-check': [],
    'zeus:policy-check': ['mode'],
    'gorgo:sandbox-health': [],
    'gorgo:paper-simulation': ['scenario'],
    'cerberus:vault-check': [],
  }[`${targetEngine}:${taskName}`];
  if (Object.keys(payload).some((key) => !allowedPayloadKeys.includes(key))) {
    throw new TypeError('unsupported_payload_field');
  }
  if (taskName === 'policy-check' && payload.mode !== 'paper') {
    throw new TypeError('only_paper_mode_is_supported');
  }
  if (
    taskName === 'paper-simulation' &&
    !['baseline', 'risk-limit'].includes(payload.scenario)
  ) {
    throw new TypeError('unsupported_paper_scenario');
  }

  return { targetEngine, taskName, payload };
}

function executeSafeTask(targetEngine, taskName, payload) {
  switch (`${targetEngine}:${taskName}`) {
    case 'zeus:health-check':
      return { status: 'observed', mode: 'paper' };
    case 'zeus:policy-check':
      return { status: 'paper_only', mode: payload.mode };
    case 'gorgo:sandbox-health':
      return { status: 'ready_for_simulation', isolated: false };
    case 'gorgo:paper-simulation':
      return { status: 'simulated', mode: 'paper', scenario: payload.scenario };
    case 'cerberus:vault-check':
      return { status: 'blocked', vaultLocked: true };
    default:
      throw new Error('unsupported_queue_task');
  }
}

function isAuthorizedDispatch(authorization, expectedToken) {
  if (!expectedToken || typeof authorization !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createValhallaQueueEngine({
  redisUrl = process.env.REDIS_URL,
  RedisClient = IORedis,
  QueueClass = Queue,
  WorkerClass = Worker,
} = {}) {
  if (!redisUrl) throw new Error('REDIS_URL is required when the queue runtime is enabled');
  const parsedUrl = new URL(redisUrl);
  if (
    !['redis:', 'rediss:'].includes(parsedUrl.protocol) ||
    (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'rediss:')
  ) {
    throw new Error('REDIS_URL must use rediss:// in production');
  }

  const connection = new RedisClient(redisUrl, { maxRetriesPerRequest: null });
  try {
    await connection.ping();
  } catch {
    await connection.quit().catch(() => {});
    throw new Error('Configured Redis is unavailable');
  }

  const queues = Object.fromEntries(
    Object.keys(QUEUE_TASKS).map((name) => [
      name,
      new Queue(`valhalla-${name}`, { connection }),
    ]),
  );
  const workers = Object.keys(QUEUE_TASKS).map(
    (targetEngine) =>
      new Worker(
        `valhalla-${targetEngine}`,
        async (job) => executeSafeTask(targetEngine, job.name, job.data.payload),
        { connection, concurrency: 1 },
      ),
  );

  connection.on('error', () => console.error('[Valhalla queue] Redis connection error'));
  for (const queue of Object.values(queues)) {
    queue.on('error', () => console.error('[Valhalla queue] Queue error'));
  }
  for (const worker of workers) {
    worker.on('error', () => console.error('[Valhalla queue] Worker error'));
  }

  return {
    async enqueue(input) {
      const { targetEngine, taskName, payload } = validateDispatch(input);
      return queues[targetEngine].add(taskName, { payload }, {
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await connection.quit();
    },
  };
}

module.exports = {
  createValhallaQueueEngine,
  executeSafeTask,
  isAuthorizedDispatch,
  validateDispatch,
};
