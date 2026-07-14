// Tests for src/redis.js — verifies graceful degradation when no Redis
// client is configured (REDIS_URL unset). No real connection is attempted.
import { test, before } from 'node:test';
import assert from 'node:assert';

let redis;

before(async () => {
  // Ensure no Redis connection is ever created during the test run.
  delete process.env.REDIS_URL;
  redis = await import('../src/redis.js');
});

test('createRedisClient returns null when REDIS_URL is not set', () => {
  const client = redis.createRedisClient();
  assert.strictEqual(client, null);
});

test('get returns null when client is null', async () => {
  const value = await redis.get('some-key');
  assert.strictEqual(value, null);
});

test('set is a safe no-op when client is null', async () => {
  await assert.doesNotReject(redis.set('k', 'v'));
  await assert.doesNotReject(redis.set('k', 'v', 60));
});

test('lrange returns empty array when client is null', async () => {
  const result = await redis.lrange('some-list', 0, -1);
  assert.deepStrictEqual(result, []);
});

test('hgetall returns empty object when client is null', async () => {
  const result = await redis.hgetall('some-hash');
  assert.deepStrictEqual(result, {});
});

test('llen/llen returns 0 when client is null', async () => {
  const result = await redis.llen('some-list');
  assert.strictEqual(result, 0);
});

test('del is a safe no-op when client is null', async () => {
  await assert.doesNotReject(redis.del('a', 'b'));
});

test('closeRedis is a safe no-op when client is null', async () => {
  await assert.doesNotReject(redis.closeRedis());
});

test('expire returns false when client is null', async () => {
  const result = await redis.expire('some-key', 60);
  assert.strictEqual(result, false);
});
