// Tests for src/memory.js — friend memory storage layer.
// Uses a simple Map-backed mock redis instead of real ioredis.
import { test } from 'node:test';
import assert from 'node:assert';

function createMockRedis() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, val) {
      store.set(key, val);
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    _store: store,
  };
}

// ─────────────────────────── getFriendMemory ───────────────────────────

test('getFriendMemory returns defaults for unknown user', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();
  const result = await mem.getFriendMemory(redis, 'unknown-user');
  assert.deepStrictEqual(result, { facts: [], mood: null, moodUpdatedAt: null });
});

test('getFriendMemory returns stored data', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();
  await redis.set(
    'waifu:friend:u1',
    JSON.stringify({ facts: ['likes cats', 'hates spam'], mood: 'happy', moodUpdatedAt: 1000 }),
  );
  const result = await mem.getFriendMemory(redis, 'u1');
  assert.deepStrictEqual(result, {
    facts: ['likes cats', 'hates spam'],
    mood: 'happy',
    moodUpdatedAt: 1000,
  });
});

test('getFriendMemory returns defaults when redis is null', async () => {
  const mem = await import('../src/memory.js');
  const result = await mem.getFriendMemory(null, 'no-redis-user');
  assert.deepStrictEqual(result, { facts: [], mood: null, moodUpdatedAt: null });
});

// ─────────────────────────────── addFact ───────────────────────────────

test('addFact stores fact, skips duplicate', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  const count1 = await mem.addFact(redis, 'u2', 'likes dogs');
  assert.strictEqual(count1, 1);

  const result1 = await mem.getFriendMemory(redis, 'u2');
  assert.deepStrictEqual(result1.facts, ['likes dogs']);

  // Case-insensitive duplicate should be skipped
  const count2 = await mem.addFact(redis, 'u2', 'LIKES DOGS');
  assert.strictEqual(count2, 1);

  const result2 = await mem.getFriendMemory(redis, 'u2');
  assert.deepStrictEqual(result2.facts, ['likes dogs']);

  // Different fact should be added
  const count3 = await mem.addFact(redis, 'u2', 'loves walks');
  assert.strictEqual(count3, 2);

  const result3 = await mem.getFriendMemory(redis, 'u2');
  assert.deepStrictEqual(result3.facts, ['likes dogs', 'loves walks']);
});

test('addFact caps at 50 facts (FIFO drop)', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  // Insert 51 facts
  for (let i = 1; i <= 51; i++) {
    await mem.addFact(redis, 'u-cap', `fact number ${i}`);
  }

  const result = await mem.getFriendMemory(redis, 'u-cap');
  assert.strictEqual(result.facts.length, 50);
  // The oldest (fact number 1) should have been shifted out
  assert.strictEqual(result.facts[0], 'fact number 2');
  assert.strictEqual(result.facts[49], 'fact number 51');
});

test('addFact no-op when redis is null', async () => {
  const mem = await import('../src/memory.js');
  const count = await mem.addFact(null, 'nobody', 'should not crash');
  assert.strictEqual(count, 0);
});

// ─────────────────────────────── setMood ───────────────────────────────

test('setMood stores mood text and timestamp', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  await mem.setMood(redis, 'u3', 'excited');
  const result = await mem.getFriendMemory(redis, 'u3');

  assert.strictEqual(result.mood, 'excited');
  assert.ok(typeof result.moodUpdatedAt === 'number');
  assert.ok(result.moodUpdatedAt > 0);
  assert.strictEqual(result.facts.length, 0);
});

test('setMood no-op when redis is null', async () => {
  const mem = await import('../src/memory.js');
  // Should not throw
  await mem.setMood(null, 'nobody', 'happy');
});

// ──────────────────────────── deleteFact ───────────────────────────────

test('deleteFact by index', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  await mem.addFact(redis, 'u4', 'fact A');
  await mem.addFact(redis, 'u4', 'fact B');
  await mem.addFact(redis, 'u4', 'fact C');

  await mem.deleteFact(redis, 'u4', 1); // remove 'fact B'

  const result = await mem.getFriendMemory(redis, 'u4');
  assert.deepStrictEqual(result.facts, ['fact A', 'fact C']);
});

test('deleteFact by text match', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  await mem.addFact(redis, 'u5', 'alpha');
  await mem.addFact(redis, 'u5', 'beta');
  await mem.addFact(redis, 'u5', 'gamma');

  await mem.deleteFact(redis, 'u5', 'beta'); // remove by exact text

  const result = await mem.getFriendMemory(redis, 'u5');
  assert.deepStrictEqual(result.facts, ['alpha', 'gamma']);
});

test('deleteFact no-op when redis is null', async () => {
  const mem = await import('../src/memory.js');
  await mem.deleteFact(null, 'nobody', 0);
  await mem.deleteFact(null, 'nobody', 'anything');
});

// ──────────────────────────── clearMemory ──────────────────────────────

test('clearMemory wipes all data', async () => {
  const mem = await import('../src/memory.js');
  const redis = createMockRedis();

  await mem.setMood(redis, 'u6', 'sad');
  await mem.addFact(redis, 'u6', 'secret');

  // Verify data exists before clearing
  const before = await mem.getFriendMemory(redis, 'u6');
  assert.strictEqual(before.mood, 'sad');
  assert.strictEqual(before.facts.length, 1);

  await mem.clearMemory(redis, 'u6');

  const after = await mem.getFriendMemory(redis, 'u6');
  assert.deepStrictEqual(after, { facts: [], mood: null, moodUpdatedAt: null });
});

test('clearMemory no-op when redis is null', async () => {
  const mem = await import('../src/memory.js');
  await mem.clearMemory(null, 'nobody');
});
