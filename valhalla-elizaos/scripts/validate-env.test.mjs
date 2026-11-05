import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnvironment } from './validate-env.js';

test('allows optional integrations outside production', () => {
  assert.equal(validateEnvironment({ NODE_ENV: 'development' }), true);
});

test('requires a model provider in production', () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: 'production' }),
    /Production requires at least one model provider key/,
  );
});

test('accepts a configured production model provider', () => {
  assert.equal(
    validateEnvironment({ NODE_ENV: 'production', OPENAI_API_KEY: 'configured' }),
    true,
  );
});

test('rejects partially configured Supabase and Upstash REST credentials', () => {
  assert.throws(
    () => validateEnvironment({ SUPABASE_URL: 'https://db.example.test' }),
    /SUPABASE_URL and SUPABASE_ANON_KEY must be configured together/,
  );
  assert.throws(
    () => validateEnvironment({ UPSTASH_REDIS_REST_TOKEN: 'configured' }),
    /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together/,
  );
});

test('validates integration URL protocols', () => {
  assert.throws(
    () => validateEnvironment({ REDIS_URL: 'https://redis.example.test' }),
    /REDIS_URL must be a valid URL using redis: or rediss:/,
  );
  assert.throws(
    () =>
      validateEnvironment({
        UPSTASH_REDIS_REST_URL: 'http://redis.example.test',
        UPSTASH_REDIS_REST_TOKEN: 'configured',
      }),
    /UPSTASH_REDIS_REST_URL must be a valid URL using https:/,
  );
});

test('requires encrypted Supabase and Redis URLs in production', () => {
  assert.throws(
    () =>
      validateEnvironment({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'configured',
        SUPABASE_URL: 'http://db.example.test',
        SUPABASE_ANON_KEY: 'configured',
        REDIS_URL: 'redis://cache.example.test',
      }),
    /SUPABASE_URL must be a valid URL using https:/,
  );
  assert.throws(
    () =>
      validateEnvironment({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'configured',
        REDIS_URL: 'redis://cache.example.test',
      }),
    /REDIS_URL must be a valid URL using rediss:/,
  );
});

test('refuses to enable execution capabilities that are not implemented', () => {
  assert.throws(
    () => validateEnvironment({ VALHALLA_TRADING_ENABLED: 'true' }),
    /VALHALLA_TRADING_ENABLED must remain false/,
  );
});
