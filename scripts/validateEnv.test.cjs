const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('./validateEnv');

const production = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
  MASTER_ADMIN_EMAIL: 'owner@example.test',
  LEADER_EMAIL: 'owner@example.test',
};

test('allows an owner-configured production environment without enabling queues', () => {
  assert.equal(validateEnv(production), true);
});


test('requires production database and owner configuration', () => {
  assert.throws(
    () => validateEnv({ NODE_ENV: 'production' }),
    /SUPABASE_URL is required in production/,
  );
});

test('requires the master admin secret to match the verified owner secret', () => {
  assert.throws(
    () => validateEnv({ ...production, MASTER_ADMIN_EMAIL: 'attacker@example.test' }),
    /must match the Google-authenticated LEADER_EMAIL secret/,
  );
  assert.equal(
    validateEnv({ ...production, MASTER_ADMIN_EMAIL: 'OWNER@example.test' }),
    true,
  );
});

test('requires TLS Redis and a long server token when queues are enabled', () => {
  assert.throws(
    () => validateEnv({ ...production, VALHALLA_QUEUE_ENABLED: 'true' }),
    /REDIS_URL is required when the queue is enabled/,
  );
  assert.throws(
    () =>
      validateEnv({
        ...production,
        VALHALLA_QUEUE_ENABLED: 'true',
        REDIS_URL: 'redis://cache.example.test',
        VALHALLA_DISPATCH_TOKEN: 'short',
      }),
    /REDIS_URL must be a valid rediss: URL/,
  );
  assert.equal(
    validateEnv({
      ...production,
      VALHALLA_QUEUE_ENABLED: 'true',
      REDIS_URL: 'rediss://cache.example.test',
      VALHALLA_DISPATCH_TOKEN: '01234567890123456789012345678901',
    }),
    true,
  );
});