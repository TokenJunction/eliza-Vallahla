'use strict';

const { timingSafeEqual } = require('node:crypto');
const IORedis = require('ioredis');
const { Queue, Worker, RedisConnection, UnrecoverableError } = require('bullmq');

const QUEUE_TASKS = Object.freeze({
  zeus: new Set(['health-check', 'policy-check']),
  gorgo: new Set(['sandbox-health', 'paper-simulation']),
  cerberus: new Set(['vault-check']),
});
const MAX_PAYLOAD_BYTES = 4096;
const PRODUCER_COMMAND_TIMEOUT_MS = 5000;

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
  role = 'combined',
  startupTimeoutMs = 10000,
  signal,
  onState = () => {},
} = {}) {
  validateQueueConfig({ redisUrl, role });
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) {
    throw new Error('invalid_startup_timeout');
  }
  if (signal?.aborted) throw new Error('startup_cancelled');

  const connections = [];
  const queues = {};
  const workers = [];
  const blockingClients = [];
  let closed = false;
  let ready = null;
  let started = false;
  let stopped = false;
  let closePromise;
  const state = (value) => {
    if (ready === value) return;
    ready = value;
    onState({ ready: value, role, capabilities: ['paper-only', 'allowlisted-tasks'] });
  };
  const refresh = () => {
    if (started && !closed) {
      state(!stopped && connections.every((connection) => connection.status === 'ready') &&
        blockingClients.every((client) => client.status === 'ready') &&
        workers.every((worker) => worker.isRunning()));
    }
  };
  function createConnection(producer) {
    const connection = new RedisClient(redisUrl, {
      maxRetriesPerRequest: producer ? 1 : null,
      ...(producer ? {
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        commandTimeout: PRODUCER_COMMAND_TIMEOUT_MS,
      } : {}),
      connectTimeout: Math.min(startupTimeoutMs, 5000),
      retryStrategy: (attempt) => Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000),
    });
    connections.push(connection);
    connection.on('error', () => console.error(JSON.stringify({ component: 'queue', error: 'redis_error' })));
    connection.on('close', () => state(false));
    connection.on('ready', refresh);
    return connection;
  }

  function close(force = false) {
    if (closePromise) return closePromise;
    closed = true;
    state(false);
    if (force) connections.forEach((connection) => connection.disconnect());
    closePromise = (async () => {
      try {
        const workerResults = await Promise.allSettled(workers.map((worker) => worker.close(force)));
        const queueResults = await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
        if ([...workerResults, ...queueResults].some((result) => result.status === 'rejected')) {
          throw new Error('queue_cleanup_failed');
        }
      } finally {
        connections.forEach((connection) => connection.disconnect());
      }
    })();
    return closePromise;
  }

  let timer;
  let abort;
  try {
    const startup = (async () => {
      const producerConnection = role !== 'consumer' ? createConnection(true) : null;
      const consumerConnection = role !== 'producer' ? createConnection(false) : null;
      await Promise.all(connections.map((connection) => RedisConnection.waitUntilReady(connection)));
      if (closed) return;
      await Promise.all(connections.map((connection) => connection.ping()));
      if (closed) return;
      if (role !== 'consumer') {
        for (const name of Object.keys(QUEUE_TASKS)) {
          queues[name] = new QueueClass(`valhalla-${name}`, { connection: producerConnection });
          queues[name].on('error', () => console.error(JSON.stringify({ component: 'queue', error: 'queue_error' })));
        }
      }
      if (role !== 'producer') {
        for (const targetEngine of Object.keys(QUEUE_TASKS)) {
          const worker = new WorkerClass(
            `valhalla-${targetEngine}`,
            async (job) => {
              let dispatch;
              try {
                if (!job.data || typeof job.data !== 'object' || Array.isArray(job.data) ||
                    Object.keys(job.data).some((key) => key !== 'payload') ||
                    !Object.hasOwn(job.data, 'payload')) {
                  throw new Error('invalid_job');
                }
                dispatch = validateDispatch({ targetEngine, taskName: job.name, payload: job.data.payload });
              } catch {
                throw new UnrecoverableError('invalid_job');
              }
              return executeSafeTask(targetEngine, dispatch.taskName, dispatch.payload);
            },
            { connection: consumerConnection, concurrency: 1, autorun: false },
          );
          worker.on('error', () => {
            state(false);
            console.error(JSON.stringify({ component: 'queue', error: 'worker_error' }));
          });
          worker.on('ioredis:close', () => state(false));
          workers.push(worker);
        }
      }
      await Promise.all([
        ...Object.values(queues).map((queue) => queue.waitUntilReady()),
        ...workers.map((worker) => worker.waitUntilReady()),
      ]);
      if (closed) return;
      for (const worker of workers) {
        const client = await worker.getBackend().blockingConnection.client;
        if (closed) return;
        blockingClients.push(client);
        client.on('close', () => state(false));
        client.on('ready', refresh);
      }
      for (const worker of workers) {
        void worker.run().catch(() => {
          stopped = true;
          state(false);
          console.error(JSON.stringify({ component: 'queue', error: 'worker_stopped' }));
        });
      }
      started = true;
      refresh();
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('startup_timeout')), startupTimeoutMs);
      if (signal) {
        abort = () => reject(new Error('startup_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    await Promise.race([startup, deadline]);
  } catch (error) {
    void close(true).catch(() => console.error(JSON.stringify({ component: 'queue', error: 'cleanup_failed' })));
    if (error.message === 'startup_timeout' || error.message === 'startup_cancelled') throw error;
    throw new Error('redis_unavailable');
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }

  return {
    getStatus: () => ({ ready: ready === true, role, capabilities: ['paper-only', 'allowlisted-tasks'] }),
    async enqueue(input) {
      if (closed || !ready || role === 'consumer') throw new Error('queue_unavailable');
      const { targetEngine, taskName, payload } = validateDispatch(input);
      return queues[targetEngine].add(taskName, { payload }, {
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
    close,
  };
}

function validateQueueConfig({ redisUrl, role }) {
  if (!['producer', 'consumer', 'combined'].includes(role)) throw new Error('invalid_queue_role');
  if (!redisUrl) throw new Error('REDIS_URL is required when the queue runtime is enabled');
  let parsedUrl;
  try {
    parsedUrl = new URL(redisUrl);
  } catch {
    throw new Error('invalid_redis_url');
  }
  if (
    !['redis:', 'rediss:'].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    (process.env.NODE_ENV === 'production' && parsedUrl.protocol !== 'rediss:') ||
    parsedUrl.search || parsedUrl.hash
  ) {
    throw new Error('REDIS_URL must use rediss:// in production');
  }
}

module.exports = {
  createValhallaQueueEngine,
  executeSafeTask,
  isAuthorizedDispatch,
  validateQueueConfig,
  validateDispatch,
};
